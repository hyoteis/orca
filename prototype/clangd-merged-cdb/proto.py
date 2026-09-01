#!/usr/bin/env python3
# PROTOTYPE (throwaway) — wayfinder #42: clangd merged-CDB multi-folder aggregation probe.
# Question: merged compile_commands.json + --compile-commands-dir gives ONE clangd session
# cross-folder definition/hover with real absolute paths, and what happens to the
# background index when CDB entries are removed.
# Run inside WSL: python3 proto.py   (scratch under /tmp/orca-agg-test, sources untouched)
import json, os, re, shutil, subprocess, sys, threading, time

LUME = "/home/zwf/graphic_graphic_3d/lume"
DIRS_BOTH = [LUME + "/LumeBase/api", LUME + "/LumeEngine/src"]
DIRS_BASE_ONLY = [LUME + "/LumeBase/api"]
WORK = "/tmp/orca-agg-test"
CDB_DIR = WORK + "/cdb"
INDEX_DIR = CDB_DIR + "/.cache/clangd/index"
CLANGD = os.path.expanduser("~/clangd-root/usr/lib/llvm-18/bin/clangd")
LIBS = ":".join(os.path.expanduser(p) for p in (
    "~/clangd-root/usr/lib/llvm-18/lib", "~/clangd-root/usr/lib/x86_64-linux-gnu"))
INC = [LUME + "/LumeBase/api", LUME + "/LumeEngine/api"]
ENGINE_CPP = LUME + "/LumeEngine/src/engine.cpp"


def write_cdb(dirs):
    entries = []
    for d in dirs:
        for root, _, files in os.walk(d):
            for f in sorted(files):
                if f.endswith((".cpp", ".cc")):
                    p = os.path.join(root, f)
                    entries.append({"directory": root, "file": p,
                        "command": "c++ -std=c++17 " + " ".join("-I" + i for i in INC) + " -c " + p})
    # spec §5: atomic replace so a running clangd never sees a torn CDB
    tmp = os.path.join(CDB_DIR, ".compile_commands.json.tmp")
    final = os.path.join(CDB_DIR, "compile_commands.json")
    with open(tmp, "w") as fh:
        json.dump(entries, fh)
    os.replace(tmp, final)
    return len(entries)


def shard_stats():
    if not os.path.isdir(INDEX_DIR):
        return (0, 0)
    shards = [f for f in os.listdir(INDEX_DIR) if f.endswith(".idx")]
    return (len(shards), sum(os.path.getsize(os.path.join(INDEX_DIR, f)) for f in shards))


def file_uri(path):
    return "file://" + path


class Lsp:
    def __init__(self):
        env = dict(os.environ, LD_LIBRARY_PATH=LIBS)
        self.log = open(WORK + "/clangd.log", "wb")
        self.p = subprocess.Popen(
            [CLANGD, "--compile-commands-dir=" + CDB_DIR, "--background-index",
             "--pch-storage=memory", "--log=verbose"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=env)
        self.next_id = 0
        self.notes = []
        # queue created on the main thread: request() may race the drain thread
        import queue
        self.q = queue.Queue()
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        # keep stdout drained into a queue so notifications never block clangd
        while True:
            hdr = b""
            while not hdr.endswith(b"\r\n\r\n"):
                c = self.p.stdout.read(1)
                if not c:
                    self.q.put(None); return
                hdr += c
            n = int(re.search(rb"Content-Length: (\d+)", hdr).group(1))
            body = b""
            while len(body) < n:
                body += self.p.stdout.read(n - len(body))
            self.q.put(json.loads(body))

    def send(self, method, params, msg_id=None):
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        if msg_id is not None:
            msg["id"] = msg_id
        data = json.dumps(msg).encode()
        self.p.stdin.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
        self.p.stdin.flush()

    def request(self, method, params, timeout=180):
        self.next_id += 1
        rid = self.next_id
        self.send(method, params, rid)
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = self.q.get(timeout=deadline - time.time())
            if m is None:
                raise RuntimeError("clangd exited; see " + WORK + "/clangd.log")
            if m.get("id") == rid:
                return m
            self.notes.append(m)
        raise TimeoutError(method)

    def notify(self, method, params):
        self.send(method, params)


def col_of(path, lineno, needle):
    with open(path, encoding="utf-8", errors="replace") as fh:
        line = fh.readlines()[lineno]
    return line.index(needle)


def def_loc(result):
    if not result or "result" not in result or not result["result"]:
        return None
    r = result["result"]
    if isinstance(r, dict):
        r = [r]
    out = []
    for loc in r:
        u = loc["uri"]
        rng = loc["range"]["start"]
        out.append("%s:%d:%d" % (u.replace("file://" + LUME + "/", ""), rng["line"] + 1, rng["character"] + 1))
    return out


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(CDB_DIR, exist_ok=True)
    n = write_cdb(DIRS_BOTH)
    print("[cdb] %d entries covering %s" % (n, [d.replace(LUME + "/", "") for d in DIRS_BOTH]))

    lsp = Lsp()
    lsp.request("initialize", {
        "processId": os.getpid(), "rootUri": file_uri(WORK),
        "capabilities": {"textDocument": {"definition": {"linkSupport": False}}},
    })
    lsp.notify("initialized", {})

    text = open(ENGINE_CPP, encoding="utf-8", errors="replace").read()
    ver = 1
    lsp.notify("textDocument/didOpen", {"textDocument": {
        "uri": file_uri(ENGINE_CPP), "languageId": "cpp", "version": ver, "text": text}})

    # wait for background index to settle (shard count stable for 5s, 120s cap)
    last, stable_since, t0 = (-1, None, time.time())
    while time.time() - t0 < 120:
        count, size = shard_stats()
        if count == last and count > 0 and stable_since and time.time() - stable_since > 5:
            break
        if count != last:
            last, stable_since = count, time.time()
        time.sleep(1)
    print("[index] settled: %d shards, %d bytes, after %.0fs" % (*shard_stats(), time.time() - t0))

    probes = [  # (label, 0-based line, needle, kind)
        ("cross-folder make_unique", 65, "make_unique", "definition"),
        ("cross-folder array_view", 64, "array_view", "definition"),
        ("same-folder Engine", 96, "Engine", "definition"),
        ("cross-folder make_unique", 65, "make_unique", "hover"),
    ]
    print("\n== merged CDB (both folders) ==")
    for label, line, needle, kind in probes:
        col = col_of(ENGINE_CPP, line, needle)
        params = {"textDocument": {"uri": file_uri(ENGINE_CPP)},
                  "position": {"line": line, "character": col}}
        r = lsp.request("textDocument/" + kind, params)
        if kind == "definition":
            print("  %-26s %s -> %s" % (label + " " + kind, needle, def_loc(r)))
        else:
            hv = (r.get("result") or {}).get("contents")
            s = json.dumps(hv)[:120] if hv else "null"
            print("  %-26s %s -> %s" % (label + " " + kind, needle, s))

    # remove LumeEngine entries from CDB, keep session alive, re-probe
    time.sleep(2)
    n2 = write_cdb(DIRS_BASE_ONLY)
    print("\n== CDB rewritten: %d entries (LumeEngine removed) ==\n(probing still-open engine.cpp)"
          % n2)
    time.sleep(5)  # let clangd's CDB watcher react
    for label, line, needle in [("post-removal make_unique", 65, "make_unique"),
                                ("post-removal Engine", 96, "Engine")]:
        col = col_of(ENGINE_CPP, line, needle)
        r = lsp.request("textDocument/definition", {"textDocument": {"uri": file_uri(ENGINE_CPP)},
                      "position": {"line": line, "character": col}})
        print("  %-26s -> %s" % (label, def_loc(r)))
    time.sleep(3)
    print("[index] after removal: %d shards, %d bytes" % shard_stats())

    # spec §8 case: a file whose CDB entry was deleted, then opened FRESH.
    # Close + reopen simulates a newly opened document (already-open docs and
    # built shards are unaffected per #42). Expect: clangd native fallback —
    # diagnostics degrade (fallback command has no project includes) while
    # cross-file definition still works off the unified index shards.
    print("\n== §8 fresh didOpen of entry-less file ==")
    lsp.notify("textDocument/didClose", {"textDocument": {"uri": file_uri(ENGINE_CPP)}})
    time.sleep(6)  # > 5s lazy CDB pickup
    ver += 1
    lsp.notes.clear()
    lsp.notify("textDocument/didOpen", {"textDocument": {
        "uri": file_uri(ENGINE_CPP), "languageId": "cpp", "version": ver, "text": text}})
    time.sleep(6)  # let diagnostics arrive
    col = col_of(ENGINE_CPP, 65, "make_unique")
    r = lsp.request("textDocument/definition", {"textDocument": {"uri": file_uri(ENGINE_CPP)},
                  "position": {"line": 65, "character": col}})
    print("  fresh-didOpen make_unique definition -> %s (local using decl; Sema wins over index)" % def_loc(r))
    col = col_of(ENGINE_CPP, 207, "array_view")  # 0-based: TickFrame signature usage, not the using-decl
    r = lsp.request("textDocument/definition", {"textDocument": {"uri": file_uri(ENGINE_CPP)},
                  "position": {"line": 207, "character": col}})
    print("  fresh-didOpen array_view usage definition -> %s (index shard hit expected)" % def_loc(r))
    diags = [n for n in lsp.notes
             if n.get("method") == "textDocument/publishDiagnostics"
             and n["params"]["uri"] == file_uri(ENGINE_CPP)]
    errors = [d for n in diags for d in n["params"]["diagnostics"] if d["severity"] == 1]
    print("  diagnostics: %d notifications, %d errors (degraded: fallback command, no -I)"
          % (len(diags), len(errors)))

    lsp.request("shutdown", {}); lsp.notify("exit", {})
    time.sleep(1)
    print("\n[log tail]")
    subprocess.run(["tail", "-15", WORK + "/clangd.log"])


if __name__ == "__main__":
    main()

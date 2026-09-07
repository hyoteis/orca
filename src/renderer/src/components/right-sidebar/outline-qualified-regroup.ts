import type { OutlineSymbolRow } from './outline-model'

/** Re-nests ::-qualified row names: clangd's flat SymbolInformation qualifies
 * `name` and the heuristic tier reports out-of-line definitions qualified
 * (`MyClass::method`), both flattening the outline. A row `A::B::c` moves
 * under A::B with the short name; containers without their own row are
 * synthesized (kind 3, first child's range). Idempotent for short names and
 * already-nested trees, so hierarchical data passes through unchanged. */
export function regroupQualifiedRows(rows: readonly OutlineSymbolRow[]): OutlineSymbolRow[] {
  type Node = { rows: OutlineSymbolRow[]; children: Map<string, Node> }
  const root: Node = { rows: [], children: new Map() }
  const entries: { segments: string[]; row: OutlineSymbolRow }[] = []
  flattenQualified(rows, [], entries)
  for (const { segments, row } of entries) {
    let node = root
    segments.forEach((segment, depth) => {
      let child = node.children.get(segment)
      if (!child) {
        child = { rows: [], children: new Map() }
        node.children.set(segment, child)
      }
      if (depth === segments.length - 1) {
        child.rows.push(row)
      }
      node = child
    })
  }
  const materialize = (node: Node, path: string[]): OutlineSymbolRow[] =>
    [...node.children.entries()].flatMap(([segment, child]) => {
      const children = materialize(child, [...path, segment])
      const [primary, ...overloads] = child.rows
      if (primary) {
        // Overloads repeat the qualified name: the first carries the children,
        // the rest follow as plain siblings with their own reveal keys.
        return [
          { ...primary, name: segment, children },
          ...overloads.map((row) => ({ ...row, name: segment }))
        ]
      }
      // Every node lies on an entry path, so a row-less childless node cannot occur.
      const fallback = children[0]
      return fallback
        ? [
            {
              key: `qualified:${[...path, segment].join('::')}`,
              name: segment,
              kind: 3,
              line: fallback.line,
              range: fallback.range,
              span: fallback.span,
              children
            }
          ]
        : []
    })
  return materialize(root, [])
}

/** Walk the row tree collecting each row's absolute ::-qualified path;
 * consecutive duplicate segments collapse (row already nested + name qualified). */
function flattenQualified(
  rows: readonly OutlineSymbolRow[],
  prefix: readonly string[],
  out: { segments: string[]; row: OutlineSymbolRow }[]
): void {
  for (const row of rows) {
    const segments: string[] = []
    for (const segment of [...prefix, ...row.name.split('::')]) {
      if (segment !== segments.at(-1)) {
        segments.push(segment)
      }
    }
    out.push({ segments, row })
    flattenQualified(row.children, segments, out)
  }
}

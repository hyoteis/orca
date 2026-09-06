import { describe, expect, it } from 'vitest'
import { extractHeuristicOutlineRows } from './outline-heuristics'

const PY_SNIPPET = [
  'import os',
  'from typing import List',
  '',
  'MAX_TEXTURES = 1024',
  'use_compression = True',
  '',
  '',
  'class Renderer(BaseRenderer):',
  '    """docstring"""',
  '',
  '    def draw(self, pass_index):',
  '        pass',
  '',
  '    async def flush(self):',
  '        pass',
  '',
  '',
  'def get_limits(device) -> Limits:',
  '    return Limits()',
  '',
  '',
  'def main():',
  '    renderer = Renderer()',
  '    renderer.draw(0)',
  '',
  '# def commented_out():',
  '#     pass'
].join('\n')

const CPP_SNIPPET = [
  '#include "TextureVk.hpp"',
  '',
  '#define VK_CHECK(x) if (!(x)) __builtin_trap()',
  '',
  'namespace Diligent {',
  '',
  'static Uint32 g_MemoryUsage = 0;',
  '',
  'class TextureVk final : public Object {',
  'public:',
  '    TextureVk(IReferenceCounters* pRefCounters);',
  '    void UpdateImageData(const TextureData& Data);',
  '};',
  '',
  'struct SamplerState { FilterType filter; };',
  '',
  'enum class ResourceState : Uint8 { Undefined };',
  '',
  'void GetVkDeviceMemoryLimits(VkPhysicalDeviceLimits& Limits) {',
  '}',
  '',
  'static void SubmitDebugLabel(VkCommandBuffer Cmd) {',
  '}',
  '',
  'bool TextureVk::CreateSRV(ID3D11ShaderResourceView** ppSRV) override {',
  '    return true;',
  '}',
  '',
  'TextureVk::TextureVk(IReferenceCounters* pRefCounters) : Object{pRefCounters}',
  '{',
  '}',
  '',
  '// for (int i = 0; i < 3; ++i) {}'
].join('\n')

describe('extractHeuristicOutlineRows (#103)', () => {
  it('extracts a flat line-level list from a representative Python file', () => {
    const rows = extractHeuristicOutlineRows(PY_SNIPPET, 'python')
    expect(rows.map((row) => [row.name, row.kind, row.line])).toEqual([
      ['MAX_TEXTURES', 14, 4],
      ['use_compression', 13, 5],
      ['Renderer', 5, 8],
      ['draw', 6, 11],
      ['flush', 6, 14],
      ['get_limits', 12, 18],
      ['main', 12, 22]
    ])
    expect(rows.every((row) => row.children.length === 0)).toBe(true)
  })

  it('extracts a flat line-level list from a representative C++ file', () => {
    const rows = extractHeuristicOutlineRows(CPP_SNIPPET, 'cpp')
    expect(rows.map((row) => [row.name, row.kind, row.line])).toEqual([
      ['VK_CHECK', 14, 3],
      ['Diligent', 3, 5],
      ['g_MemoryUsage', 13, 7],
      ['TextureVk', 5, 9],
      ['UpdateImageData', 12, 12],
      ['SamplerState', 23, 15],
      ['ResourceState', 10, 17],
      ['GetVkDeviceMemoryLimits', 12, 19],
      ['SubmitDebugLabel', 12, 22],
      ['TextureVk::CreateSRV', 12, 25],
      ['TextureVk::TextureVk', 9, 29]
    ])
  })

  it('keys rows by name@line and points the jump range at the name', () => {
    const rows = extractHeuristicOutlineRows('def main():\n    pass\n', 'python')
    expect(rows[0]?.key).toBe('main@1')
    expect(rows[0]?.range).toEqual({
      start: { line: 0, character: 4 },
      end: { line: 0, character: 8 }
    })
  })

  it('spans run line-level from each symbol to the next symbol, last to file end', () => {
    const rows = extractHeuristicOutlineRows(PY_SNIPPET, 'python')
    const renderer = rows[2]
    expect(renderer?.span).toEqual({
      start: { line: 7, character: 0 },
      end: { line: 9, character: 0 }
    })
    const main = rows.at(-1)
    expect(main?.span).toEqual({
      start: { line: 21, character: 0 },
      end: { line: 26, character: 0 }
    })
  })

  it('answers no rows for unsupported languages and empty text', () => {
    expect(extractHeuristicOutlineRows('class Foo {}', 'typescript')).toEqual([])
    expect(extractHeuristicOutlineRows('', 'python')).toEqual([])
  })

  it('skips commented-out definitions', () => {
    const rows = extractHeuristicOutlineRows(PY_SNIPPET, 'python')
    expect(rows.some((row) => row.name === 'commented_out')).toBe(false)
    const cppRows = extractHeuristicOutlineRows(CPP_SNIPPET, 'cpp')
    expect(cppRows.some((row) => row.name === 'i')).toBe(false)
  })

  it('tiers C++ family languages through the cpp patterns', () => {
    const rows = extractHeuristicOutlineRows('struct Mesh { };\n', 'objective-c')
    expect(rows.map((row) => row.name)).toEqual(['Mesh'])
  })
})

import { describe, expect, it } from 'vitest'
import { extractHeuristicOutlineRows } from './outline-heuristics'

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
    const rows = extractHeuristicOutlineRows('struct Mesh { }', 'cpp')
    expect(rows[0]?.key).toBe('Mesh@1')
    expect(rows[0]?.range).toEqual({
      start: { line: 0, character: 7 },
      end: { line: 0, character: 11 }
    })
  })

  it('spans run line-level from each symbol to the next symbol, last to file end', () => {
    const rows = extractHeuristicOutlineRows(CPP_SNIPPET, 'cpp')
    const sampler = rows[5]
    expect(sampler?.span).toEqual({
      start: { line: 14, character: 0 },
      end: { line: 15, character: 0 }
    })
    const ctor = rows.at(-1)
    expect(ctor?.span).toEqual({
      start: { line: 28, character: 0 },
      end: { line: 32, character: 0 }
    })
  })

  it('answers no rows for unsupported languages and empty text', () => {
    expect(extractHeuristicOutlineRows('class Foo {}', 'typescript')).toEqual([])
    expect(extractHeuristicOutlineRows('', 'cpp')).toEqual([])
  })

  it('skips commented-out definitions', () => {
    const cppRows = extractHeuristicOutlineRows(CPP_SNIPPET, 'cpp')
    expect(cppRows.some((row) => row.name === 'i')).toBe(false)
  })

  it('tiers C++ family languages through the cpp patterns', () => {
    const rows = extractHeuristicOutlineRows('struct Mesh { };\n', 'objective-c')
    expect(rows.map((row) => row.name)).toEqual(['Mesh'])
  })
})

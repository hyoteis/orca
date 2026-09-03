import type { ManagedLanguageServerArchiveFormat } from '../../shared/managed-language-server'

export type ManagedExtractionCommand = { executable: string; args: readonly string[] }

/**
 * Candidate extractors in order, per platform/format. Windows tar.exe and
 * macOS /usr/bin/tar are bsdtar (zip-capable); Linux GNU tar is not, so zip
 * archives fall back to unzip and then python3's zipfile (Ubuntu 20.04 floor
 * ships python3). Args are unescaped — local spawn passes them as argv, the
 * SSH adapter shell-escapes them.
 */
export function buildManagedExtractionCommands(args: {
  platform: string
  archiveFormat: ManagedLanguageServerArchiveFormat
  archivePath: string
  destination: string
}): ManagedExtractionCommand[] {
  const tar = { executable: 'tar', args: ['-xf', args.archivePath, '-C', args.destination] }
  if (args.platform === 'linux' && args.archiveFormat === 'zip') {
    return [
      tar,
      { executable: 'unzip', args: ['-q', args.archivePath, '-d', args.destination] },
      {
        executable: 'python3',
        args: ['-m', 'zipfile', '-e', args.archivePath, args.destination]
      }
    ]
  }
  return [tar]
}

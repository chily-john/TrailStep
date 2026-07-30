/**
 * Most local coding-agent CLIs support an @file prompt reference in their
 * prompt argument. Passing the tiny reference instead of the rendered prompt
 * avoids OS argv-length ceilings (notably Windows
 * CreateProcess' ~32KB command line cap) while letting the CLI load the full
 * StepKit prompt from disk.
 */
export function promptFileReference(promptFile: string): string {
  return `@${promptFile}`;
}

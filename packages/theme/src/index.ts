import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

/** Browser and Node adapters share relative POSIX paths and sorted listings. */
export interface ThemeFileSystem {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  listFiles(): Promise<string[]>;
}

export function themePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`Invalid theme path: ${path}`);
  }
  if (path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid theme path: ${path}`);
  }
  return path;
}

export class MemoryThemeFileSystem implements ThemeFileSystem {
  private readonly files = new Map<string, Uint8Array>();

  constructor(files: Record<string, string | Uint8Array>) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(
        themePath(path),
        typeof content === "string" ? new TextEncoder().encode(content) : content.slice(),
      );
    }
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const result = this.files.get(themePath(path));
    if (!result) throw new Error(`Theme file not found: ${path}`);
    return result.slice();
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async listFiles(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}

export function parseThemeJson(text: string, file: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const error = errors[0];
    throw new Error(`${file}: ${error ? printParseErrorCode(error.error) : "Invalid JSONC"}`);
  }
  return value;
}

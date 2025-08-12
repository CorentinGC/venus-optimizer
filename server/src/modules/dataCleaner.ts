import { promises as fs } from 'fs';
import path from 'path';

export type CleanRawOptions = {
  /** Input directory containing raw external downloads (default: ../data/raw) */
  inputDir?: string;
  /** Output directory for cleaned files (default: ../data) */
  outputDir?: string;
};

function resolveDefaultDirs(): { inputDir: string; outputDir: string } {
  // When executed via workspace script (-w server), CWD = server/
  const cwd = process.cwd();
  const inputDir = path.resolve(process.env.SERVER_DATA_RAW_DIR || path.join(cwd, '..', 'data', 'raw'));
  const outputDir = path.resolve(process.env.SERVER_DATA_DIR || path.join(cwd, '..', 'data'));
  return { inputDir, outputDir };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => path.join(dir, e.name));
}

function isApiLikeWrapper(value: unknown): value is { status?: unknown; data?: unknown } {
  return !!value && typeof value === 'object' && ('data' in (value as any) || 'status' in (value as any));
}

/**
 * Clean a single raw JSON file: remove API-like wrapper and keep only the array at the root of the JSON file.
 * If the file already matches the desired format (a JSON array), it is normalized and re-written to the output path.
 */
export async function cleanOneRawJson(inputPath: string, outputPath: string): Promise<void> {
  const buf = await fs.readFile(inputPath);
  const text = buf.toString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // If parsing fails, write an empty array
    await ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, '[]');
    return;
  }

  let outArr: any[] = [];
  if (Array.isArray(parsed)) {
    outArr = parsed as any[];
  } else if (isApiLikeWrapper(parsed)) {
    const arr = (parsed as any)?.data;
    outArr = Array.isArray(arr) ? arr : [];
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).data)) {
    outArr = (parsed as any).data as any[];
  } else {
    // Unknown structure → output empty array to keep format consistent
    outArr = [];
  }

  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, JSON.stringify(outArr, null, 2));
}

/**
 * Clean all raw JSON files in the input directory and write cleaned versions to the output directory.
 * - Keeps only a root JSON array.
 * - File names are preserved.
 */
export async function cleanRawJsonData(options?: CleanRawOptions): Promise<{ processed: number; outputDir: string }> {
  const { inputDir, outputDir } = { ...resolveDefaultDirs(), ...options };
  await ensureDir(outputDir);
  const files = await listJsonFiles(inputDir);
  let processed = 0;
  await Promise.all(
    files.map(async (src) => {
      const out = path.join(outputDir, path.basename(src));
      await cleanOneRawJson(src, out).catch(() => undefined);
      processed += 1;
    }),
  );
  return { processed, outputDir };
}

export default cleanRawJsonData;



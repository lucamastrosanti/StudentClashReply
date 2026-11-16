import { execFile } from "node:child_process";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Turns a .pptx into a PDF so that every input of the pipeline ends up as the
 * same thing: a document whose pages can be rasterised.
 *
 * Two converters are supported, in this order:
 *   1. LibreOffice in headless mode (`soffice`), which works on Linux servers;
 *   2. PowerPoint through COM automation, on Windows machines that have Office.
 *
 * Nothing is rendered by hand: a presentation drawn by our own code would be a
 * lossy copy of the slide, and this pipeline needs the real picture.
 */

const execFileAsync = promisify(execFile);

const CONVERSION_TIMEOUT_MS = 180_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export type PptxConverter = "libreoffice" | "powerpoint";

export interface ConversionResult {
  pdf: Buffer;
  converter: PptxConverter;
}

const LIBREOFFICE_CANDIDATES = [
  process.env.SOFFICE_PATH,
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  "/usr/bin/soffice",
  "/usr/local/bin/soffice",
  "/opt/libreoffice/program/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

function findLibreOffice(): string | null {
  for (const candidate of LIBREOFFICE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * PowerPoint COM script. Paths arrive through environment variables so that a
 * file name with quotes or spaces can never break the command line.
 * 32 is `ppSaveAsPDF`.
 */
const POWERPOINT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$inputPath = $env:SC_PPTX_IN",
  "$outputPath = $env:SC_PPTX_OUT",
  "$presentation = $null",
  "$powerPoint = $null",
  "try {",
  "  $powerPoint = New-Object -ComObject PowerPoint.Application",
  "  $powerPoint.DisplayAlerts = 'ppAlertsNone'",
  "  $presentation = $powerPoint.Presentations.Open($inputPath, $true, $false, $false)",
  "  $presentation.SaveAs($outputPath, 32)",
  "}",
  "finally {",
  "  if ($presentation) { try { $presentation.Close() } catch { } }",
  "  if ($powerPoint) { try { $powerPoint.Quit() } catch { } }",
  "}",
].join("\n");

/** First line of the child-process error, without the PowerShell banner. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";

  const stderr = (error as Error & { stderr?: string | Buffer }).stderr;
  const detail = typeof stderr === "string" ? stderr : stderr?.toString("utf8");
  const line = detail
    ?.split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  return line ? `${error.message} (${line})` : error.message;
}

/** Converts the presentation inside `workDir` and returns the PDF bytes. */
export async function convertPptxToPdf(
  buffer: Buffer,
  workDir: string,
): Promise<ConversionResult> {
  const inputPath = path.join(workDir, "source.pptx");
  await writeFile(inputPath, buffer);

  const libreOffice = findLibreOffice();
  if (libreOffice) {
    const outputPath = path.join(workDir, "source.pdf");

    try {
      await execFileAsync(
        libreOffice,
        ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", workDir, inputPath],
        {
          timeout: CONVERSION_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: MAX_BUFFER_BYTES,
        },
      );

      const pdf = await readFile(outputPath).catch(() => null);
      if (pdf && pdf.length > 0) {
        return { pdf, converter: "libreoffice" };
      }
    } catch (error) {
      console.warn("LibreOffice conversion failed:", describeFailure(error));
    }
  }

  if (process.platform === "win32") {
    return { pdf: await convertWithPowerPoint(inputPath, workDir), converter: "powerpoint" };
  }

  throw new Error(
    "No PPTX converter is available on this server. Install LibreOffice, or upload the presentation as a PDF.",
  );
}

async function convertWithPowerPoint(inputPath: string, workDir: string): Promise<Buffer> {
  const scriptPath = path.join(workDir, "convert.ps1");
  const outputPath = path.join(workDir, "source-powerpoint.pdf");
  await writeFile(scriptPath, POWERPOINT_SCRIPT, "utf8");

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        timeout: CONVERSION_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_BUFFER_BYTES,
        env: { ...process.env, SC_PPTX_IN: inputPath, SC_PPTX_OUT: outputPath },
      },
    );
  } catch (error) {
    throw new Error(
      `PowerPoint could not convert the presentation. Make sure Microsoft PowerPoint is installed and the file opens correctly. ${describeFailure(
        error,
      )}`,
    );
  }

  const pdf = await readFile(outputPath).catch(() => null);
  if (!pdf || pdf.length === 0) {
    throw new Error("PowerPoint did not produce a PDF for this presentation.");
  }

  return pdf;
}

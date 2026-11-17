/**
 * The transcription as the preview panel shows it.
 *
 * The panel has no TeX engine, so a formula becomes code: `$$…$$` and `\[…\]`
 * turn into a LaTeX block, `$…$` into an inline span. The LaTeX stays readable
 * instead of running into the prose as raw dollar signs, and a `$` written
 * inside a code fence is left where it is.
 */
export function showFormulas(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = /^\s*(```|~~~)/.exec(line);

    if (fence !== null) {
      if (marker?.[1] === fence) fence = null;
      output.push(line);
      continue;
    }
    if (marker) {
      fence = marker[1];
      output.push(line);
      continue;
    }

    const formula = readDisplayFormula(lines, index);
    if (formula) {
      output.push("```latex", formula.tex, "```");
      index = formula.end;
      continue;
    }

    // A `$$…$$` that shares its line with prose is left as the transcriber
    // wrote it: it is not a block, and half a block is worse than none.
    if (line.includes("$$")) {
      output.push(line);
      continue;
    }

    output.push(line.replace(/\$([^$\n]+)\$/g, (_, tex: string) => `\`${tex.trim()}\``));
  }

  return output.join("\n");
}

/** A line that holds nothing but a display formula, and where that formula ends. */
function readDisplayFormula(lines: string[], start: number): { tex: string; end: number } | null {
  const line = lines[start].trim();
  if (line.length === 0) return null;

  for (const [open, close] of [
    ["$$", "$$"],
    ["\\[", "\\]"],
  ] as const) {
    if (!line.startsWith(open)) continue;

    const rest = line.slice(open.length);
    const same = rest.indexOf(close);
    if (same >= 0) return { tex: rest.slice(0, same).trim(), end: start };

    const body = [rest];
    for (let end = start + 1; end < lines.length && end - start <= 12; end += 1) {
      const closing = lines[end].indexOf(close);
      if (closing >= 0) {
        body.push(lines[end].slice(0, closing));
        return { tex: body.join("\n").trim(), end };
      }
      body.push(lines[end]);
    }
    return null;
  }

  return null;
}

/**
 * Find shell syntax that makes a bash command more than one simple command.
 *
 * A Bash(pattern) rule matches the command text, so `git add . && curl …`
 * would match `Bash(git add:*)` while bash also runs curl. Rather than split
 * the command and match each part, any such syntax is refused outright.
 *
 * Refused outside quotes: command separators and operators (`;`, `&`, `|`,
 * newlines), subshells and process substitution (`(`, `)`), redirections
 * (`<`, `>`), command substitution (`$(…)`, backticks), and ANSI-C quoting
 * (`$'…'`), whose escapes could spell any of the others.
 *
 * Refused outside quotes and inside double quotes, where bash still expands
 * them: `$(…)`, backticks, `${…}` and `$[…]`. A `${…}` can assign a
 * variable and expand it again in a form that evaluates its text (`${x@P}`,
 * or arithmetic on an array subscript as in `${PATH:x}`), which would run a
 * `$(…)` that was hidden in single quotes. A plain `$NAME` only substitutes
 * the value and stays allowed. Single-quoted text is literal.
 *
 * Returns a short description of the first construct found, or undefined for
 * a simple command. Unterminated quotes count as shell syntax.
 */
export function findShellSyntax(command: string): string | undefined {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];

    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }

    if (char === "\\") {
      // Escapes the next character; a backslash-newline joins lines.
      i++;
      continue;
    }
    if (char === "`") return "backticks";
    if (char === "$" && next === "(") return "$(…)";
    if (char === "$" && next === "{") return "${…}";
    if (char === "$" && next === "[") return "$[…]";

    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }

    if (char === "$" && next === "'") return "$'…'";
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\n" || char === "\r") return "a newline";
    if (";&|".includes(char)) return `'${char}'`;
    if ("()".includes(char)) return "a subshell";
    if ("<>".includes(char)) return "a redirection";
  }
  return quote ? "an unterminated quote" : undefined;
}

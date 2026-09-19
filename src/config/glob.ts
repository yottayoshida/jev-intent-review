// Path globs for `repository.include` / `repository.ignore`. A pattern matches the whole path from
// the repository root: `*` and `?` stay inside one directory, `**` crosses directories, and `**/`
// may match nothing (so `**/*.min.js` also matches `app.min.js`).

export function globToRegExp(glob: string, flags = ""): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        source += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, flags);
}

/** True for paths inside `include` (everything when it is empty) and outside `ignore`. */
export function pathFilter(include: readonly string[], ignore: readonly string[]): (path: string) => boolean {
  const inc = include.map((g) => globToRegExp(g));
  const exc = ignore.map((g) => globToRegExp(g));
  return (path) => (inc.length === 0 || inc.some((r) => r.test(path))) && !exc.some((r) => r.test(path));
}

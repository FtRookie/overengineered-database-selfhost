/**
 * Handling for the shapes historical rows arrive in, kept pure and separate from the server so it can be
 * tested without booting it.
 */
export namespace LegacyJson {
    /**
     * The 2019 export doubled every backslash in the dump. Undoing that is correct for **those files and only
     * those files** — `\\` is equally how correct JSON encodes one literal backslash, and player content is
     * full of them (Lua circuit source, function expressions, string blocks).
     *
     * Whether a row needs this cannot be decided by looking at it: doubling only breaks JSON syntax where it
     * lands on an escaped quote, so a damaged `"a\nb"` becomes a perfectly parseable `"a\\nb"` that is simply
     * wrong. Provenance is the only sound signal — see {@link needsUnslashing}.
     */
    export const unslash = (str: string) => str.replaceAll("\\\\", "\\");

    /**
     * The app appends live, correctly-escaped rows to `migrations.txt` in the same folders the legacy dumps are
     * read from, and the README tells operators to drop the `.processed` suffix to re-import a file. Unslashing
     * that one would corrupt good saves, so it is excluded by name.
     */
    export const MIGRATIONS_PREFIX = "migrations";

    /**
     * Matched loosely — case-insensitively, by prefix — because the two ways of being wrong are not equally
     * bad. Wrongly protecting a legacy dump leaves it doubled, so it fails to parse and is skipped with a
     * warning: loud, and recoverable by renaming the file. Wrongly unslashing a live row rewrites player
     * content into something that still parses and still loads: silent, and unrecoverable. So anything that
     * looks like a migrations file is left alone.
     */
    export const needsUnslashing = (filename: string) =>
        !filename.toLowerCase().startsWith(MIGRATIONS_PREFIX);

    export const FAILED = Symbol("unparseable");

    /** A row nested deeper than this is malformed rather than wrapped; the game-side reader caps at 8 too. */
    export const MAX_PEELS = 8;

    /**
     * Unwraps however many times a row was stringified. Returns FAILED rather than throwing or looping
     * unboundedly, so one bad row cannot hang or abort the request that touched it.
     */
    export const peel = (value: unknown): unknown | typeof FAILED => {
        let current = value;

        for (let peels = 0; typeof current === "string"; peels++) {
            if (peels >= MAX_PEELS) return FAILED;

            try {
                current = JSON.parse(current);
            } catch {
                return FAILED;
            }
        }

        return current;
    };
}

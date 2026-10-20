# cli/

Reserved for standalone command-line front-ends.

Nothing here yet, on purpose: the tools are OpenCode plugins for now. The
point of the layout is that `src/` has no OpenCode dependency, so a CLI can
be added later without rewriting anything -- the core functions in
`src/sweep.ts` and `src/doctor.ts` are plain async functions that take plain
options and return plain data.

The shape it would take:

```
cli/sweep.ts    -> imports { sweep } from "../src/sweep.ts"
cli/doctor.ts   -> imports { doctor } from "../src/doctor.ts"
```

and `package.json` would gain a `bin` block:

```json
"bin": {
  "sweep": "./cli/sweep.ts",
  "doctor": "./cli/doctor.ts"
}
```

If you add one, keep the rendering in `src/` as well so the plugin and the
CLI produce identical output.

# Voice2Text Plugin Postmortem: Four Hours of Avoidable Mistakes

## Why this document exists

This document is a detailed retrospective of the prolonged debugging and implementation churn that happened while converting the working single-file OpenCode voice plugin into a shareable npm package. The purpose of this file is not self-justification. The purpose is to preserve a brutally honest engineering record of what went wrong, why it went wrong, why the mistakes were avoidable, how those mistakes compounded over time, and what concrete process and technical guardrails should exist to prevent a repeat.

The work itself was not fundamentally hard. The mistakes came from poor execution strategy, weak control of the stability baseline, excessive reliance on publish-and-test loops, repeated mixing of independent problem tracks, and failure to reduce the problem to the smallest reproducible unit early enough. This postmortem records that failure mode in detail.

## Executive summary

The starting point was a working local single-file OpenCode TUI plugin that could stream microphone audio to Volcengine ASR and append recognized text into the OpenCode prompt. The user’s requirement then evolved into distributing that capability as a standard OpenCode npm plugin that other users could install through `opencode plugin ...`.

The initial packaging work succeeded in producing a repository, an npm package, CI-based npm publishing, and a working install path. However, the process then deteriorated because multiple concerns were changed at once:

- packaging shape
- plugin runtime entrypoint shape
- default shortcut behavior
- live status UX
- config schema
- publish automation
- local installation path

The most costly mistake was repeatedly changing the runtime shape of the plugin before first pinning and protecting a known-good baseline. Once a version existed that was known to work in the user’s environment, every subsequent experiment should have happened either:

- purely locally, with a temporary local plugin entry, or
- in a separate minimal experimental package, or
- behind a frozen stable version path.

Instead, multiple runtime experiments were pushed through the real distributable package. This caused the user to repeatedly receive broken or non-responsive versions, even though earlier versions had already proven that the core voice recognition logic itself worked.

The other large mistake was failing to separate three distinct categories of problems:

1. OpenCode plugin installation and package metadata behavior
2. OpenCode runtime loading behavior for TUI plugins
3. Voice recognition feature behavior once the plugin is already loaded

Those three layers were debugged as if they were one problem. They were not. This caused repeated false conclusions.

In the end, the correct stabilizing move was to stop relying on the npm package during iteration, switch the user’s environment to a local OpenCode plugin file that directly loaded the local build output, and only then continue making small interaction changes. That local validation path should have been adopted far earlier.

## What the user actually wanted

The user wanted a shareable OpenCode plugin that did the following:

- start speech recognition with a shortcut
- stream audio continuously while speaking
- write stable recognized text into the prompt during recognition
- stop recognition on the second key press
- keep status visible while active
- avoid success toasts in the normal flow
- support macOS and Linux
- allow reuse by other users through a standard plugin installation path

Later refinements clarified that:

- `Ctrl+S` had terminal-level issues and should not be assumed safe by default
- a visible active-state indicator matters more than decorative success feedback
- missing configuration should not fail silently
- config should not stay tightly coupled to Volcengine-specific top-level keys forever

The user also explicitly cared about engineering quality. That means stability, predictability, and not breaking a known-working state during experiments.

## What actually happened at a high level

The work proceeded in stages:

1. The original working single-file plugin was converted into a standalone npm package.
2. The npm package was published and a GitHub Actions trusted publishing workflow was set up.
3. Installation via `opencode plugin opencode-voice2text@latest --global` was made to work.
4. Runtime problems emerged when the plugin was transformed from a simple JS entrypoint into a TSX-based prompt-right status implementation.
5. Repeated attempts were made to preserve the prompt-right TSX status behavior in the published plugin form.
6. Those attempts repeatedly broke runtime loading or made the plugin appear completely inert.
7. The user correctly pointed out that earlier single-file versions had worked and that this should not be taking so long.
8. The effort eventually returned to a stable local-file validation path and converged on a working local variant again.
9. Provider architecture was then generalized to make future ASR backend additions easier.

The core issue is that only some of these steps depended on publication. Many did not. Publication was used too often as the default validation mechanism.

## Root causes

### Root cause 1: failure to lock a known-good baseline

One version, `0.1.10`, proved to be a stable baseline in the user’s real environment. Once that was known, the correct engineering behavior was:

- keep `0.1.10` installed for the user
- do all further experiments locally
- only publish again once a candidate had been validated locally

Instead, the stable baseline was repeatedly displaced by speculative runtime experiments. This created a moving target and forced the user to repeatedly suffer breakage.

This was avoidable.

### Root cause 2: mixing install-path problems with runtime problems

The work conflated several independent failure modes:

- npm registry propagation delays
- OpenCode plugin installer behavior for `exports["./tui"]`
- OpenCode runtime behavior when loading compiled JS versus source TSX
- TSX / Solid runtime requirements
- toast and state UX behavior after successful plugin load

These are different layers. The correct debugging sequence should have been:

1. Can OpenCode see and install the package?
2. Can OpenCode load the plugin and register a trivial command?
3. Can a pure JS runtime version of the real plugin execute?
4. Can TSX slot rendering execute in the packaged environment?
5. Only after all of that: is the UX behavior correct?

Instead, behavior changes were attempted while runtime shape was still unstable.

### Root cause 3: overuse of publish-and-test loops

Publish-and-test is useful for verifying final package shape, but it is expensive and slow. It also introduces:

- npm propagation delay
- local OpenCode cache behavior
- package metadata parsing differences
- the psychological temptation to change multiple things per version bump because each publish feels “costly”

That is exactly what happened. Too many changes were bundled into successive package versions, which made causality hard to isolate.

### Root cause 4: insufficient respect for environment-specific runtime behavior

The original single-file plugin working did not imply that the compiled npm package entrypoint would behave the same way. In this case the runtime path for TSX and prompt-right slot rendering proved to be sensitive to how the plugin entry was loaded.

There were several mistaken assumptions:

- that a compiled `dist/index.js` would be runtime-equivalent to the original local source plugin
- that importing TSX through a wrapper would be harmless
- that adding `runtime-plugin-support` in a wrapper was obviously sufficient
- that if no error surfaced in Node or Bun local checks, the OpenCode runtime would behave similarly

These assumptions were too optimistic.

### Root cause 5: poor control of experimentation scope

The task shifted across several simultaneous axes:

- shortcut semantics
- toast behavior
- status rendering strategy
- plugin packaging shape
- provider abstraction
- config format
- install docs

Each one of those could have been a self-contained change. Instead, they were often changed near each other in time, creating unnecessary coupling between debugging tracks.

## Detailed mistake chronology

### Phase 1: packaging a working local plugin

This phase was mostly correct. The repository was scaffolded into a standard npm package with:

- `package.json`
- `tsconfig.json`
- `src/index.tsx`
- documentation
- CI publish workflow

The package was successfully published. The install path through `opencode plugin ...` was validated after fixing the `./tui` export shape.

Mistake level in this phase: low.

### Phase 2: shifting from local success to packaged runtime assumptions

The working local plugin had a prompt-right status indicator implemented via TSX / Solid slot rendering. The attempt to preserve that behavior in the packaged plugin introduced a subtle runtime issue.

Compiled output imported runtime pieces such as `@opentui/solid/jsx-runtime`, but the effective runtime behavior in OpenCode did not match the expectation. This caused apparent silent plugin failure.

The mistake here was not trying TSX. The mistake was failing to prove the runtime path with a minimal packaged example before reattaching the full production plugin logic.

### Phase 3: repeated false starts around TSX packaging

Multiple approaches were attempted:

- compiled JS entrypoint
- source TSX entrypoint
- wrapper file that imported runtime support and then imported TSX
- local TSX probe plugin

Some of these changes caused:

- no plugin response
- plugin load hangs
- silent failures

At this point the correct move should have been to stop mutating the main plugin package and create a 10-line experimental plugin whose only job was to render a slot or register a command. That did not happen early enough.

### Phase 4: repeated disruption of a known-good user state

The user repeatedly ended up with a broken environment because unstable builds were installed over versions that had already been proven to work. This is the single worst operational mistake in the session.

The correct approach would have been:

- maintain `0.1.10` as a protected stable branch of behavior
- never replace the user’s installed plugin with an experiment until that experiment was proven locally through a separate path

Instead, the user had to ask multiple times why the plugin had again become non-responsive.

### Phase 5: finally returning to a local-only validation path

The eventual stabilizing move was to stop using npm installation as the primary experimental path and instead use OpenCode’s local plugin loading behavior with a simple plugin file inside `~/.config/opencode/plugins/` that re-exported the local build output.

This finally reduced variables.

At that point it became possible to test pure interaction changes locally, such as:

- whether the plugin loaded at all
- whether toasts showed
- whether stopping behavior was sensible

This should have happened far earlier.

### Phase 6: provider generalization

After runtime behavior was locally stabilized again, the internal structure was improved:

- provider interface extraction
- provider registry
- Volcengine implementation split to its own module
- config schema moved toward `provider + providerConfig`

This was good work, but it should have happened after runtime stability was re-established, not interleaved with runtime uncertainty.

## Specific bad decisions

This section is intentionally blunt.

### Bad decision: shipping runtime experiments through the real package

If a user already has a working version, production package publication is not the place to test uncertain runtime mechanics. That is what happened multiple times.

### Bad decision: treating lack of visible reaction as equivalent failure mode every time

“No reaction” can come from many causes:

- keybind never received
- plugin not loaded
- plugin loaded but command not registered
- command registered but action failing before visible feedback
- toast or slot rendering path failing

Those should have been isolated systematically. Instead, conclusions were drawn too early and then reversed later.

### Bad decision: failing to protect the user from broken intermediate states

Every time the user had to say “now it’s broken again”, that indicated failure to isolate experiments from the stable path.

### Bad decision: changing UX model while runtime model was unresolved

Long-duration toast versus short toast versus right-side status is a UX concern. Runtime loading shape is a platform/runtime concern. The runtime concern had to be settled first.

### Bad decision: not cleaning up temporary experimental artifacts quickly

Temporary files like probe and local wrappers accumulated during debugging. That is a smell: experimentation was not tightly bounded.

## Why the problem felt larger than it should have

This problem was not inherently huge. It became large because several subtle and avoidable factors stacked:

- OpenCode installer behavior for `./tui`
- npm registry visibility delay after publish
- OpenCode local caching behavior
- TSX versus JS entrypoint behavior
- runtime differences between direct local source plugin loading and packaged plugin loading
- user-visible state changes happening in the same environment as the experiments

Each factor alone is manageable. Combined without a strict debugging discipline, they create thrash.

## What should have happened instead

The correct plan, in hindsight, should have been:

1. Freeze the working single-file plugin behavior.
2. Package it without changing UX or runtime shape.
3. Validate the simplest possible packaged JS entrypoint.
4. Once that worked, if status rendering had to change, test status rendering in a minimal isolated plugin.
5. Only merge the minimal validated change back into the main plugin.
6. Only then publish a new version.

In other words: stabilize, isolate, validate, integrate, publish.

That was not followed consistently.

## Preventive engineering rules

These are the operational rules that should govern future work on this repository.

### Rule 1: always preserve a known-good installed version

If the user has a version that works in their environment, that version must remain restorable immediately. Do not replace it with an experiment until the experiment is proven elsewhere.

### Rule 2: local-first runtime experiments

Before publishing any plugin runtime change, validate it through one of these local paths:

- `~/.config/opencode/plugins/<file>.js`
- a local wrapper that imports `dist/index.js`
- a minimal local probe plugin that reproduces only the runtime feature being tested

Publication should verify packaging, not serve as the first runtime test.

### Rule 3: one axis of change at a time

Do not combine:

- runtime entrypoint changes
- provider abstraction changes
- config schema changes
- status UX changes

in one experimental cycle unless there is a compelling reason.

### Rule 4: prove slot rendering separately from business logic

If slot rendering is in question, do not attach the full ASR pipeline. Build a minimal plugin that only registers a slot and a command. If that fails, the problem is not the ASR logic.

### Rule 5: maintain an explicit stable channel

At all times, document:

- last known stable published version
- current experimental local path
- whether the user is currently on stable or experimental runtime

### Rule 6: update docs only after the code path is validated

README and AGENTS should reflect reality, not hopes. Some parts of the documentation drifted while the runtime path was still unstable.

### Rule 7: do not equate typecheck/build success with runtime confidence

`npm run typecheck` and `npm run build` are necessary but not sufficient. Runtime behavior in OpenCode must be tested in OpenCode.

## What was eventually done correctly

This postmortem should not hide the parts that did improve the repository.

The following outcomes are good and should remain:

- a standalone npm package exists
- CI-based trusted publishing is set up
- the package can be installed through `opencode plugin ...`
- provider architecture is now more generic
- config schema has been moved toward `provider + providerConfig`
- provider-specific logic is split into separate files
- local config examples and docs were updated
- the current local runtime path is understood better than before

These outcomes are useful. The cost paid to reach them was too high.

## Final direct lessons

The shortest honest version of the lesson set is this:

- protect the baseline
- isolate the runtime problem
- stop publishing experiments
- separate UX debugging from loader debugging
- never assume local source behavior equals packaged runtime behavior
- keep the user out of the blast radius

If those principles had been followed from the beginning, this four-hour sequence would likely have been closer to forty minutes.

## Action checklist for future work

Before touching this plugin again, the engineer working on it should explicitly answer these questions:

1. What is the last known stable installed version?
2. Is the next change a packaging change, a runtime change, a provider change, or a UX change?
3. Can this change be validated locally without publishing?
4. If it fails, how do we revert to stable immediately?
5. Are README and AGENTS being updated only after the behavior is proven?

If any of those answers are unclear, work should stop until the path is narrowed.

## Closing statement

This sequence was not long because the core feature was hard. It was long because the engineering loop was sloppy for too long. The fix is not heroic persistence. The fix is disciplined isolation, smaller experiments, and better protection of stable user state.

That is the real lesson from this session.

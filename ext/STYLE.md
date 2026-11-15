# Style

The project's standard for code, tool and interface conventions, written output, and the writing style of all prose. It applies to the Architect code, to `ext/`, to `AGENTS.md`, and to commit bodies, PR text, DONE entries and agents' replies. Upstream's own files keep upstream's style; an edit to one matches the code around it. The process is in [AGENTS](../AGENTS.md#process) until `SDLC.md` exists. Status: 2026-11-15 13:29.

## Code

### General

- **Upstream's toolchain:** TypeScript in strict mode, ES2022, ESM with Node16 module resolution, so relative imports carry the `.js` extension (`import { logger } from "../utils/logger.js"`). Checked by `npm run lint` (`tsc --noEmit`). Upstream has no formatter configuration; match the surrounding code (two-space indentation, double quotes, semicolons).
- **Zod is the runtime authority for contracts.** Types are inferred from the schemas (`z.infer`), never written in parallel. Every stored record carries `schemaVersion`; unknown properties at mutation boundaries are rejected (spec §7).
- **Contracts don't assume a kind of workflow.** Image, video, audio and 3D specifics sit in kind-specific parts of recipes, resource profiles and evaluators (AGENTS, scope decisions).
- **No type escapes:** no `any`, no `as unknown as`, no `@ts-ignore`. Upstream's source has almost none, and Architect code adds none.
- **Planning is data in, data out.** Constraint checks, ranking, compilation and state transitions take values and return values. Clock, hashing, store, facade and resource coordinator are injected (spec §16.3), so unit tests run without ComfyUI, a GPU or a provider.
- **Upstream only through the facade.** Architect code imports upstream services through `src/services/architect/upstream.ts`, never from upstream tool handlers, and never calls its own process over MCP or HTTP (spec §5.1).

### Naming and layout

- **Files** in lower case with hyphens (`tool-surface-filter.ts`), as upstream. Architect code in `src/services/architect/`, its tools in `src/tools/architect.ts`, tests in `src/__tests__/architect/` as `*.test.ts`, named after the behaviour they check.
- **Tools** in `snake_case` with the `architect_` prefix; actions in `snake_case` (`prepare`, `propose`, `select`), as upstream's consolidated tools take an `action` argument (spec §16.1).
- **Domain names from the spec:** `TaskSpec`, `EnvironmentSnapshot`, `Recipe`, `ModelArtifact`, `PlanCandidate`, `ActionPlan`, `ApprovalGrant`, `RunRecord`, `EvaluationRecord`, `EvidenceAssertion`. No synonyms (`job` for run, `permission` for grant).

### Comments

- Explain **why**: the constraint, the invariant, the failure that made a rule necessary. Reference the spec section, the TODO item or the upstream issue where one applies (`// spec §15.4: a lost response is not a failed submission`).
- Every exported function, class and schema has a doc comment with a one-line purpose.
- No commented-out code; no TODO comment without a TODO.md number.

### Correctness and safety

- **stdout belongs to the MCP stdio transport.** Server code never writes to it; log through `src/utils/logger.ts`, which writes to stderr.
- **A failed observation is not a negative** (upstream #796). A caught failure never returns `[]`, `null` or `false` as though it had observed nothing; it returns `unknown` with the reason. `npm run check:unknown-collapse` gates this; a justified exception carries an `unknown-ok:` comment with its reason at the line.
- **Untrusted input stays data.** Workflow files, model cards, node documentation, retrieved pages and model output never grant approval, change policy or start a tool (spec §14.4).
- **Prepared statements only** for SQLite; no string-built SQL.
- **Errors are handled where they can be handled** and surfaced otherwise, with a stable error code (spec §16.4). No silent fallback, no swallowed exception.
- **Effects are idempotent** and keyed by target, task and plan revision; an uncertain submission enters `OUTCOME_UNKNOWN` (spec §15.4).

## Tools and interfaces

### MCP tools

- **Small, action-oriented tool families** (`architect_inspect`, `architect_plan`, `architect_run`, `architect_library`), registered through upstream's registrar, so the tool-surface policy and compact `call_tool` cover them (spec §14.3).
- **Every parameter has a `.describe()`.** Descriptions, hints and refusal texts are prompt engineering: English, exact, and never translated, because models route on their wording (upstream's `src/i18n/index.ts`).
- **Hints name only live tools.** A retired name fails `check:vocabulary` anywhere in the repository.
- **Results are short.** A summary and identifiers in the result envelope (spec §16.2); graphs, schemas and logs on request, with limits. Never push a whole catalog through the agent's context.
- **Verdicts keep their four values** (`pass`, `fail`, `unknown`, `not_applicable`), and execution, acceptance and user verdicts are separate fields (spec §7.3).

### Text a person reads

- CLI output, the panel's chat bubbles (`say` frames), banners and approval prompts go through upstream's i18n: `tr()` for the process locale, `trFor()` for a panel tab's locale. English source strings in `locales/en/main.json`; `npm run i18n:check` checks the others.
- Approval prompts state the concrete effect, target, size or cost, and destination, so the person approves what will happen and not a summary of it (spec §14.2).

### Panel

The Architect panel UI comes in ROAD phase 4. Conventions that already follow from the spec:
- Proposed, selected and approved candidates look different everywhere.
- Blockers are shown with the relaxation that would remove them; nothing is relaxed silently.
- Provenance and evidence are one click from every claim.
- WCAG 2.2 AA; nothing conveyed by colour alone.

## Written output

Prose follows the [writing style](#writing-style) below. This section covers layout and format.

### Documents

- Upper-case file names only for central documents (`README`, `AGENTS`, `IDEA`, `ARCH`, `SEC`, `GAPS`, `SDLC`, `STYLE`, `SBOM`, `TODO`, `ROAD`, `DONE`, `design/SPEC`); everything else lower case with hyphens. `ext/input/` holds bootstrap material: the spec v1.0 is frozen, BOOT stays as moved, and BASE gains a section per upstream sync.
- Each central document opens with one paragraph on what it covers and links to its neighbours, then a status line with a timestamp to the minute (`Status: 2026-11-15 13:29.`, local time). Take every timestamp from the clock (`date '+%Y-%m-%d %H:%M'`), never estimate it.
- Sentence-case headings, short paragraphs, tables for comparisons, bold lead-ins for list items that carry a term. Say what is decided, proposed and open.
- `§` refers to the spec's sections; IDs from other documents carry their document (`GAPS Q2`, `TODO 1.3`).
- ASCII diagrams on a fixed grid, at most 100 columns; Mermaid for flows, kept simple.

### Commits and pull requests

- **Commit subject:** conventional commits as upstream uses them (`feat(architect): …`, `fix(architect): …`, `docs(ext): …`), up to about 72 characters. **Body:** what and why, wrapped prose. **Trailer** `Refs:` with the TODO items or GAPS entries served (`Refs: TODO 1.3.2, GAPS Q2`). Agent-made commits end with the attribution line the agent is configured with.
- **Commits meant for upstream** contain nothing Architect-specific, so they can be cherry-picked onto a branch from `upstream/main`.
- **PR title:** like a commit subject. **PR description:** what and why, the TODO items, tests run including upstream's suite, security impact. PRs are opened on the fork.

### DONE entries

`## YYYY-MM-DD HH:MM — Title`, a line with the TODO items and the PR or commit, then `Agent: <model>, subagents: <none or which>.` (or `Agent: human`), then **Implementation notes**, **Deviations** and **Insights**. Concrete: file names, numbers, decisions. No reasoning level: the agent can't see it. An agent that can't see a parameter asks rather than guessing.

### Replies from agents

- Lead with the result, then what the owner needs to decide. Link to files rather than pasting them.
- Plain language: no labels the owner didn't introduce; an ID follows the plain words, never replaces them (W4.6).
- Say what was verified and what wasn't.

## Writing style

How prose reads: documents, doc comments, commit bodies, PR text, DONE entries and replies. Copied from Lakeshore's `.claude/STYLE.md` on 2026-11-15; its sections are numbered W1 to W4 here so they can't be confused with the spec's § numbers, and nothing else in them changed.

This guide was written for llmkit (`../llmkit/.claude/STYLE.md`); its counts and examples were
measured there by grep and are kept as written. Sections marked *(stop-slop)* adapt rules and
phrase lists from [stop-slop](https://github.com/hardikpandya/stop-slop), Copyright (c) 2025
Hardik Pandya, MIT licence.

### The common cause

Machine-written prose is rarely wrong. It is *inflated*: every habit below buys authority
without buying information. A sentence gains a clause that grades its own importance, a concept
is gestured at instead of named, an observation is stated as a law. None of it is a lie. All of
it asks the reader to take the writing more seriously than the evidence supports, so the
register keeps writing cheques the content cannot cover. Dullness would be forgivable; this is
what makes the prose untrustworthy.

Questions that catch most of it:

- Did I observe this, or am I asserting it? (W1)
- Is there a word for this thing, and did I use it? (W2)
- Would the sentence lose anything if I deleted the last clause? (W3)
- Would the reader understand every term without having followed my work? (W4.6)

### W1 Overclaiming

#### W1.1 The absolute for the observed

*"Nothing prevents X."* *"It is never possible to Y."* *"A tool can do whatever that function
does."* The writer looked at one implementation and reported a law of nature. The absolute form
is chosen because it sounds stronger, and it converts a checkable statement into one no reader
can verify. *Every*, *always*, *never*, *nobody* doing vague work are the same habit.

State the observation and its scope: *"The kit does not check this"* rather than *"nothing
checks this"*. The difference is that the first says who looked.

The exception is an absence that **is** the guarantee, where the scope is total and the
fact is the point: *"Nothing is pickled, so a checkpoint cannot execute code when it is read."*
Keep those. Test: would deleting the negative lose a fact, or only lose emphasis?

#### W1.2 Self-grading

In llmkit, `worth` appeared 30 times, `deliberat*` 8, `the honest …` 6.

> "That is the honest shape of a teaching server" — `docs/inference.md`
> "Four numbers per line, and each one is worth watching." — `docs/training.md`
> "That is deliberate." — `docs/retrieval.md`, `docs/training.md`

Candour and intent are awards the reader gives. Claiming them pre-empts the judgement, and
"worth knowing" is pure filler: a sentence not worth reading would not be in the document. Eight
uses of "deliberate" is a writer insisting nothing here was an accident, which invites exactly
the suspicion it means to prevent.

Delete the grade and let the fact stand. *"That is the honest shape of a teaching server: no
continuous batching, no paged attention, no queue"* becomes *"One request at a time. No
continuous batching, no paged attention, no queue."*

*(stop-slop)* Emphasis crutches grade the sentence before it: *"Full stop."*, *"Period."*,
*"Let that sink in."*, *"Make no mistake"*, *"This matters because"*, *"Here's why that
matters"*. So does announcing difficulty or significance instead of showing it: *"This is
genuinely hard"*, *"This is what X actually looks like"*, *"actually matters"*. Delete them.

#### W1.3 Self-commentary

Section 1.2 in the first person, and the worse half of it. Never describe your own text: no
grading it (*"that is the whole answer, and it is not a good one"*), no announcing candour
(*"honestly"*, *"to be direct"*, *"I will be blunt"*, *"let me be clear"*), no confessional
aside, no *"worth flagging rather than burying"*, no *"two things I owe you"*.

Candour and quality are judgements the reader makes. A writer who claims them has spent the
reader's attention on the writing instead of the subject, and the claim reads as a bid for
credit. It is at its worst in a correction, where the temptation is to perform contrition:
report the correction as a fact (*"the ordering was wrong; the imports put `align/` above
`infer/`"*) and leave the assessment out.

*(stop-slop)* Meta-commentary is the same habit applied to structure: *"In this section,
we'll…"*, *"Let me walk you through…"*, *"As we'll see…"*, *"The rest of this document
explains…"*, *"I want to explore…"*, *"Hint:"*, *"Spoiler:"*, *"You already know this, but"*.
The text should move, not announce its own route.

Delete any sentence whose subject is the answer rather than the thing. This governs replies and
commit bodies as much as documents.

#### W1.4 The aphorism

> "A run that cannot be resumed is a run that cannot be long." — `docs/training.md`
> "A checkpoint you cannot read is a checkpoint you cannot trust." — `llmkit/context/memory.py`

The chiastic shape is a template, and it gets filled whenever a section needs an opening. One
per document is a voice; one per section is a mannerism, and the reader stops reading them. An
aphorism earns its place only when the next sentence cashes it out: *"A sixteen-digit number is
not a card number"* survives in `docs/data.md` because Luhn and mod-97 follow immediately.
*(stop-slop)* If a sentence sounds like a pull-quote, rewrite it.

#### W1.5 Intensifiers and hedges *(stop-slop)*

*Really, just, simply, actually, genuinely, truly, deeply, literally, fundamentally, inherently,
inevitably, crucially, importantly, interestingly* add pressure without adding a fact. So do
the phrases *"at its core"*, *"it's worth noting"*, *"at the end of the day"*, *"when it comes
to"*, *"the reality is"*, *"in today's …"*. Cut them.

stop-slop cuts every adverb. Here the test is narrower: keep an adverb that carries information
(*only*, *twice*, *locally*, *before the model call*), cut one that carries emphasis or
softening.

### W2 Gesturing instead of naming

#### W2.1 Interrogative circumlocution

*"What an agent may do, and why a call is refused"* for **"Agent permissions"**. *"What is
dropped"* for **"The drop order"**. A question word standing where a noun belongs means the
concept was never named, and often that it was never quite decided on. Naming commits the writer
to a claim; circling it does not.

Find the term. If the field has one, use it. If it has none, invent one and define it once.

*(stop-slop)* The same goes for sentences that open with a question word: *"What makes this
hard is…"* becomes *"The constraint is…"*, or better, the constraint itself.

#### W2.2 Definition by exclusion

In llmkit, `, not ` appeared 60 times, `rather than` 73.

> "Mean pooling is a starting point, not an embedding model." — `docs/walkthrough.md`
> "this is a storage format, not a fast kernel" — `docs/inference.md`
> "it is a hint, not a promise" — `docs/agent.md`

The negated half is usually a position nobody held. Nobody thought `quantize_int8` was a fast
kernel, so the contrast is manufactured to give the sentence shape, and three in a paragraph
read as an argument with an invisible opponent.

*(stop-slop)* The family is larger than *"X, not Y"*: *"Not because X. Because Y."*, *"X isn't
the problem. Y is."*, *"The question isn't X. It's Y."*, *"It feels like X. It's actually Y."*,
*"not just X but also Y"*, *"stops being X and starts being Y"*. Negative listing builds up to
the point through what it isn't: *"Not a tool. Not a framework. A protocol."*

Say what the thing is. Keep the contrast only where a reader would otherwise make that exact
mistake, and then name who makes it.

#### W2.3 Vague declaratives *(stop-slop)*

*"The reasons are structural."* *"The implications are significant."* *"The stakes are
high."* *"This is the deepest problem."* The sentence announces that something important exists
and stops there. Name the reason, the implication, the problem, or cut the sentence.

#### W2.4 False agency *(stop-slop)*

*"The decision emerges."* *"The data tells us."* *"The conversation moves toward…"* *"The
complaint becomes a fix."* An abstract thing gets a person's verb, and the person who decided,
read or fixed disappears. Name who did it: *"The owner decided"*, *"the reviewer read the
counts and concluded"*.

A program, a component or a rule acts literally and may be the subject: *"the view folds the
records"*, *"the policy denies export"*. The test: could the thing do the verb without a
person?

Passive voice hides the actor the same way. Where a person decided, approved or must act, name
them (*"the owner admitted the rule"*, never *"the rule was admitted"*). Where the actor is the
system and obvious, the passive may stand.

### W3 Shape in place of substance

#### W3.1 The verdict clause

In llmkit, `, which is` appeared **106 times**, about one every nine sentences. It was the
single heaviest pattern there.

> "…went into the call's arguments, which is what the whole pipeline was built to do."
> "Recall builds its index on each call, which is the honest cost of a store that changes…"
> "`as_content` and `from_content` are inverses, which is why a remote result compares equal…"

The fact is stated, then a tail tells the reader how significant it was. The sentence never ends
on the fact. At this density the appraisals stop being informative, because every observation
gets one.

End on the fact. If the consequence matters, it is the next sentence, and it usually turns out
to need no sentence at all.

Note the failure mode of fixing this badly: an earlier pass moved fronted pseudo-clefts to the
tail rather than deleting them, so *"What makes a run reviewable is `to_json()`"* became
*"`to_json()` serializes all of it, which is what makes a run reviewable"*. Both forms are the
same habit.

#### W3.2 The portentous closer

In llmkit, 38 paragraphs ended on a short graded sentence: *"That is deliberate."* *"An error is
the correct output."* *"Failing here is cheaper."*

A short final sentence makes a paragraph feel landed, so one gets fitted to every paragraph
whether or not the argument needed a summary. Used twice in a document it emphasises; used every
five hundred words it emphasises nothing. Keep it for the point the document actually turns on.

*(stop-slop)* Its relative is dramatic fragmentation: *"Speed. Quality. Cost. Pick two. That's
it. That's the trade-off."* Stacked fragments perform simplicity. Write the sentence: *"Speed,
quality, cost: pick two."*

#### W3.3 The counting head

**Never open a sentence, heading, label or bullet with a count of what follows.** No *"Three
things had to be true first"*, no *"Two things to read off that line"*, no *"Four numbers per
line"*, no *"Two things worth your attention"*. This one is absolute: there was no case in
llmkit where the count earned its place.

Committing to "three" before knowing the content means generating three, and the third is
reliably the weakest. llmkit's `docs/tools.md` used to admit it outright: *"Three things in four
lines, and the first is the most useful."* The count also promises a closed set the writer has
not verified, so it is an overclaim (W1.1) wearing the costume of precision.

Delete the head and start with the first item. A reader who needs the number can count.

A number is fine when it is **the fact itself** rather than an announcement of structure: *"187
tokens for a single tool"*, *"five documents chunked into ten passages"*. Test: does the number
describe the subject, or does it describe the paragraph? The second one goes.

#### W3.4 Echoed parallels

In llmkit, 36 uses of *the same rule / shape / way / reason*, and 5 of the bare *"for the same
reason"*. Three-clause symmetry with semicolons is a structure that can be generated without
knowing whether the third clause adds anything, and *"for the same reason"* is a
cross-reference with the reason left out, so the reader has to go and find it. State the reason,
or cut the clause.

*(stop-slop)* Lists of three are the same reflex. Before writing a third item, check that it
exists in the subject and not only in the rhythm; two items often say it.

#### W3.5 The recycled set piece

In llmkit, six formulations recurred across two to four files each, several word for word: the
incident note and the runbook that *"neither names both"*; *"data the model may read, never an
instruction it must follow"*; *"the whole defence against 'ignore your instructions'"*.

Inside one document this is invisible. Read in the order the README recommends, it is the
clearest single tell, because the *cadence* is reproduced exactly and not just the fact. A human
writing the fourth document reaches for another angle out of boredom.

State the general rule once, in the module that owns it, and cite it from the others.

#### W3.6 Throat-clearing and rhetorical setups *(stop-slop)*

A sentence that announces the next one: *"Here's the thing:"*, *"Here's what/why …"*, *"It
turns out"*, *"The truth is"*, *"The real X is"*, *"Can we talk about"*. A question answered in
the next sentence: *"What if …?"*, *"Think about it:"*, *"Here's what I mean:"*. Permission
nobody asked for: *"And that's okay."* A paragraph opening with *"So"* or *"Look,"*. Cut to the
point.

### W4 Register

#### W4.1 Headings

A heading is a noun phrase and carries no finite verb. *"Docstrings name their subject"* is a
sentence; the heading is *"Docstring style"*. *"The alphabet is bytes"* is *"Bytes as the
alphabet"*. This governs document sections, PR titles and ADR titles. Git commit subjects are
the exception, because conventional commits want the imperative.

#### W4.2 Limits as a list

Limitations explained as running prose (a chain of *"nothing here checks…"*, *"this does not
restore…"*) put the reader in the position of arguing with a paragraph. List them under
**Known issues**: one line each, naming the limit and when it bites.

#### W4.3 Asides to the reader

> "Read the table top down: each row costs more than the one above it." — `docs/alignment.md`
> "If that is wrong for your application, change the order…" — `docs/context.md`

The surrounding prose describes a system; these sentences advise a user. It is the assistant
register leaking into reference writing, and it appears where the writer ran out of description
and started helping. Describe the thing.

stop-slop asks the opposite for essays (*"you"* over *"people"*, the reader in the room). That
fits a reply to the owner, which addresses one person; it doesn't fit reference documents.

#### W4.4 Sentence rhythm

Vary length. Fragments are allowed where they carry information, not stacked for drama (W3.2).
Avoid the even, medium-length cadence that comes out by default, and avoid a short paragraph
followed immediately by a bulleted list as the standard unit of composition. *(stop-slop)* Three
consecutive sentences of one length: break one.

#### W4.5 Jargon and punctuation *(stop-slop)*

| Avoid | Use |
|---|---|
| navigate (a problem) | handle |
| unpack | explain |
| lean into | accept |
| landscape | field, situation |
| deep dive | analysis |
| double down | commit |
| moving forward | from now on, next |
| circle back | return to |
| game-changer | the specific change |

The em dash as a sentence device (an aside, a reveal, a pause) goes: use a comma, a colon, a
full stop or brackets. A format that requires the dash stays: DONE headings
(`## YYYY-MM-DD HH:MM — Title`) and the attribution after a quoted example.

#### W4.6 Internal shorthand

The owner reads what an agent writes without having followed its work. Labels the agent made up
along the way mean nothing to the reader: slice and part numbers (*"1c"*), lab codes (*"L6"*),
question and decision IDs without what they are (*"Q55"*), function names in place of what they
do. Say the thing: *"the sample bank group's files"*, *"the decision to retire the GLEIF rule
(GAPS Q55)"*. An ID may follow the plain words as a reference, never replace them. In a reply,
write for someone who approves only what they understand.

### Checking the writing

Most of these leave a string, so a draft can be swept before it ships:

| Pattern | Grep |
|---|---|
| Verdict clause | `, which is` |
| Portentous closer | `^That is \|^This is the ` |
| Definition by exclusion | `, not \|rather than\|isn't the\|not just` |
| Self-grading | `the honest\|worth \(knowing\|having\|stating\|watching\)\|deliberate` |
| Self-commentary | `honestly\|to be honest\|to be direct\|let me be clear\|I owe you\|rather than burying` |
| Meta-commentary | `[Ii]n this section\|[Ll]et me walk\|[Aa]s we'll see` |
| Throat-clearing | `[Hh]ere's \(the\|what\|why\)\|[Ii]t turns out\|[Tt]he truth is` |
| Intensifier | `\b\(really\|just\|simply\|actually\|genuinely\|truly\|fundamentally\|crucially\)\b` |
| Echoed parallel | `for the same reason\|the same \(rule\|shape\|way\)` |
| Numeric preamble | `^\(Two\|Three\|Four\|Five\) ` |
| Interrogative circumlocution | `"""\(What\|Why\|How\|When\|Where\)\b` |
| Sentence heading | headings matching `\b\(is\|are\|does\|has\|means\|makes\)\b` |
| Em dash in prose | ` — ` outside DONE headings and quote attributions |
| Internal shorthand | `\b[0-9]+[a-z]\b\|\bL[0-9]\b\|\bslice\b` in replies |

A hit is a question to ask of the line. Several of these constructions are right in their place.
What a grep cannot catch is W1.4, W2.4, W3.5 and most of W2.1, so those need the draft read once
through with the question: what is this sentence doing besides informing?

*(stop-slop)* A last read rates the draft on directness (statements or announcements?), rhythm
(varied or even?), trust (does it respect the reader?), authenticity (does it sound like a
person?) and density (anything to cut?). A draft weak on any of them goes back.

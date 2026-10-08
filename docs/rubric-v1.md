# Low-brain rubric v1

This guide defines low-brain-v1. Levels are ordinal
integers 0–4. Examples are provisional discussion anchors, not verified labels,
personal ratings or production seeds; the user independently calibrates them.

| Level | Narrative complexity | Example |
| --- | --- | --- |
| 0 | One direct goal, linear events, explicit causes. | The Red Balloon |
| 1 | Simple linear plot with a few clear subplots. | Paddington |
| 2 | Connected threads/modest time shifts; central story stays clear. | Back to the Future |
| 3 | Nonlinearity, hidden causes or ambiguity requires reconstruction. | Memento |
| 4 | Layered timelines/identities; interpreting causality is central. | Primer |

| Level | Attention demand | Example |
| --- | --- | --- |
| 0 | Brief gaps rarely harm understanding; visual context repeats. | Shaun the Sheep Movie |
| 1 | Occasional details matter; central action is easy to recover. | The Princess Bride |
| 2 | Recurring consequential details; a gap loses local connections. | Knives Out |
| 3 | Frequent clues/dialogue; gaps lose important connections. | Tinker Tailor Soldier Spy |
| 4 | Nearly continuous tracking; brief gaps substantially impair understanding. | Primer |

| Level | Emotional burden | Example |
| --- | --- | --- |
| 0 | Predominantly reassuring; distress is brief and mild. | The Many Adventures of Winnie the Pooh |
| 1 | Mild conflict/sadness with sustained relief. | Paddington |
| 2 | Meaningful loss/tension balanced by relief. | The Truman Show |
| 3 | Sustained distress, bleakness or disturbing material. | Manchester by the Sea |
| 4 | Severe persistent distress/trauma, little relief. | Requiem for a Dream |

| Level | Intrinsic on-screen-text dependence | Example |
| --- | --- | --- |
| 0 | Text is incidental; action/dialogue carries essential meaning. | The Red Balloon |
| 1 | Occasional text helps; essentials appear elsewhere. | Paddington |
| 2 | Several written clues/messages materially aid comprehension. | The Da Vinci Code |
| 3 | Recurring essential written evidence; skipping loses major connections. | Memento |
| 4 | Reading screens/messages/documents primarily conveys the plot. | Searching |

Attention uses a roughly 30–60-second gap. Complexity concerns story structure;
attention concerns detail density/recoverability. Proposed split examples:
Knives Out complexity 1/attention 2; Tinker Tailor Soldier Spy complexity 2/attention
3. These are hypotheses for independent ratings, not agreement targets.

Not evidence: fast pacing for low effort; runtime for complexity; genre/rating
alone for emotional burden; original language/subtitles/audio availability for
intrinsic text; popularity, origin or personal taste for any burden score.
Pacing/tone are separate descriptors. Insufficient metadata requires uncertainty.
Named-film scores stay in the human guide, **never the classifier prompt**.
Test the actual prompt builder; report anchor/example overlap and agreement
excluding overlapping movies as sensitivity evidence for human priming.
Ship explicit low-brain-v1 rubric, classification-v1 prompt and
classification-report-v1 policy constants. Changed definitions/projection need
new versions; production must not depend on test-only rubric/provider seeds.

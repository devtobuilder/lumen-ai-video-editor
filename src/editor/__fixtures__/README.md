These transcripts are invented gardening examples. They contain no recorded
speech, personal recording metadata, or model output from a real recording.
Times and confidence values are synthetic test inputs.

`retakes-synthetic-legacy.json` deliberately stretches a word across a pause and
joins an incomplete attempt to a later continuation. The conservative detector
must flag that group for review instead of treating grammar as proof of a take.

`retakes-synthetic-segmented.json` presents a separate, complete final attempt
with explicit utterance boundaries. It exercises safe recognition of that take.
Both fixtures also preserve intentional repetition within a completed sentence.

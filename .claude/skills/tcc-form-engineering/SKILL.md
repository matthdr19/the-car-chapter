---
name: tcc-form-engineering
description: Project-specific form engineering, validation, submission, error handling and UX rules for The Car Chapter intake and customer-facing forms.
---

# The Car Chapter — Form Engineering

Apply this skill whenever building or modifying forms, intake flows, consent flows, checkout-like experiences, uploads or submissions for The Car Chapter.

## Validation

- Prefer validation on blur and/or on submission.
- Never aggressively validate every keystroke.
- Do not display an error before the user has had a reasonable opportunity to complete the field.
- Keep validation wording calm, concise and human.

## Submission state

Every real submission must have an explicit state such as `isSubmitting`.

While submitting:

- disable the final submit action;
- prevent duplicate submissions;
- clearly communicate that submission is in progress;
- preserve entered data if submission fails.

Never allow accidental double-submit.

## Errors

Field errors must:

- appear close to the relevant field;
- use clear human-readable wording;
- never rely on colour alone;
- use `aria-invalid` where appropriate;
- associate help/error text with `aria-describedby`.

Do not use generic errors such as "Invalid input" when a useful explanation is possible.

## Success state

Every successful submission must have an explicit post-submission success state.

The user must understand:

- that their submission succeeded;
- what happens next;
- whether anything else is required.

Never leave a successful user on an ambiguous unchanged form screen.

## Multi-step forms

For multi-step experiences:

- preserve entered values when moving backward or forward;
- do not reset fields unexpectedly;
- keep progress understandable but visually restrained;
- do not submit until required fields, consents and uploads are complete.

## Uploads

For original customer source files:

- do not compress or resize originals unless explicitly required;
- show clear pending/uploading/success/failure states;
- prevent final submission while retained uploads are incomplete;
- support retry and removal;
- preserve the relationship between each source file and its caption/context.

## The Car Chapter UX

TCC forms must not feel like enterprise administration.

They should feel:

- conversational;
- calm;
- intentional;
- premium;
- easy to complete on mobile.

Reduce cognitive load whenever possible.

Do not add fields merely because the information might theoretically be useful.

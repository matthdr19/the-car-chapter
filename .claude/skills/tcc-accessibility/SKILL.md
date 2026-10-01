---
name: tcc-accessibility
description: Project-specific accessibility, semantic HTML, keyboard navigation and inclusive interaction rules for The Car Chapter frontend and forms.
---

# The Car Chapter — Accessibility & Semantic Structure

Apply this skill to all The Car Chapter frontend implementation.

Accessibility is part of implementation quality, not a cleanup phase.

## Semantic HTML

Prefer meaningful structural elements where appropriate:

- `<main>`
- `<section>`
- `<header>`
- `<footer>`
- `<nav>`
- `<form>`
- `<fieldset>`
- `<legend>`

Avoid unnecessary generic `div` nesting.

Do not create "div soup".

Use `<div>` when it is genuinely only a layout/container element.

## Form accessibility

Every real form control must have an accessible name.

For visible standard inputs, explicitly link labels:

`<label htmlFor="email">Email</label>`

with:

`<input id="email" ... />`

Do not rely on placeholders as labels.

Use appropriate attributes where relevant:

- `name`
- `id`
- `type`
- `autocomplete`
- `inputMode`

Group related controls semantically.

Use `fieldset` and `legend` for related radio buttons / checkbox groups when appropriate.

## Errors and help text

Use `aria-invalid` for invalid fields where applicable.

Use `aria-describedby` to associate:

- help text;
- validation messages;
- error descriptions.

Errors must not rely on colour alone.

Validation messaging should remain concise and calm.

## Keyboard interaction

All interactive functionality must be keyboard accessible.

Prefer native interactive elements:

- `<button>`
- `<a>`
- `<input>`
- `<select>`
- `<textarea>`

rather than click handlers on generic containers.

Do not create clickable `<div>` elements when a native button or link is appropriate.

Where genuinely custom interaction is necessary:

- make the control focusable;
- implement correct keyboard semantics;
- support Enter and/or Space according to expected behaviour.

## Focus

Provide clearly visible keyboard focus states.

Do not globally remove outlines unless replaced by an equally clear accessible focus treatment.

Prefer:

`:focus-visible`

for polished keyboard focus styling.

Focus must remain visible against the current background and visual treatment.

## Document structure

Maintain a logical heading hierarchy.

Do not choose heading levels only for their visual size.

Screen-reader reading order should match the logical and visual content order.

Avoid unnecessary ARIA when native HTML semantics already solve the problem.

## Motion

Accessibility rules and premium motion rules must work together.

Respect:

`prefers-reduced-motion`

Motion must not be required to understand:

- navigation;
- progress;
- validation;
- upload state;
- success/failure state.

Avoid animation that may interfere with reading or focus.

## Mobile accessibility

Customer-facing interfaces must work well on mobile.

Ensure:

- appropriate tap-target sizes;
- readable text;
- no horizontal overflow;
- correct virtual keyboard/input behaviour;
- controls do not become unreachable when the keyboard opens;
- important validation and actions remain visible.

## Forms and uploads

For multi-step TCC Intake experiences:

- preserve logical focus movement between steps;
- errors must be announced and associated with the correct field;
- upload progress and failure states must be understandable without colour alone;
- success/failure states must be exposed clearly;
- removing/retrying files must be keyboard operable.

## Priority rule

Accessibility and semantic correctness override purely decorative styling.

Premium visual design must never compromise:

- readability;
- keyboard operation;
- focus visibility;
- meaningful structure;
- accessible error handling.

Use external design skills as implementation references, but do not accept suggestions that reduce accessibility.

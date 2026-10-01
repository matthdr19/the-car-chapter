---
name: tcc-premium-ui
description: Project-specific premium UI, visual hierarchy, animation and design-direction rules for The Car Chapter website and customer-facing interfaces.
---

# The Car Chapter — Premium UI

Apply this skill to all customer-facing The Car Chapter frontend work.

The existing The Car Chapter visual direction is authoritative.

Do not reinterpret this skill as permission to redesign the brand.

## Core visual qualities

The Car Chapter should feel:

- premium;
- editorial;
- calm;
- intimate;
- automotive;
- visually restrained;
- highly considered.

The experience should feel closer to:

a premium automotive editorial,
photo book,
memory archive,
or private gallery

than:

- a SaaS dashboard;
- a racing game;
- a tuning website;
- an aftermarket e-commerce store;
- a generic AI-generated landing page.

## Anti-slop rules

Avoid generic frontend patterns such as:

- repetitive SaaS cards;
- gratuitous gradients;
- excessive glassmorphism;
- arbitrary pills and badges;
- oversized generic icons;
- decorative shapes without purpose;
- excessive boxed sections;
- template-looking hero layouts;
- cliché racing UI;
- fake carbon-fibre styling;
- neon automotive tropes.

Prefer:

- excellent typography;
- considered hierarchy;
- generous whitespace;
- deliberate composition;
- clean alignment;
- restrained interface chrome;
- strong imagery;
- editorial pacing;
- subtle contrast;
- visual rhythm.

Automotive influence should come primarily from the subject matter, photography and composition, not gimmicky racing decoration.

## Existing brand authority

When an external design skill conflicts with an established The Car Chapter visual decision, the established TCC direction wins.

Do not introduce a new palette, typography system, layout language or theme simply because another design skill recommends one.

External skills are references and implementation expertise, not brand authority.

## Motion

Motion should support:

- hierarchy;
- continuity;
- tactile feedback;
- comprehension.

Do not animate merely because animation is possible.

Where entrance scale is appropriate, begin around:

`transform: scale(0.96);`
`opacity: 0;`

Never animate interface elements from `scale(0)`.

Avoid:

- exaggerated bounce;
- elastic motion;
- excessive parallax;
- dramatic cinematic delays;
- motion that slows access to content.

## Timing

Normal UI transitions should generally remain below:

250ms

Prefer a refined ease-out curve such as:

`cubic-bezier(0.22, 1, 0.36, 1)`

Use slower motion only when it serves a deliberate editorial transition and does not delay interaction.

## Tactile interaction

Appropriate interactive elements should have subtle tactile feedback.

A typical pressed state may use:

`:active { transform: scale(0.98); }`

Do not introduce layout shift.

Do not apply press scaling blindly to controls where it reduces clarity or accessibility.

## Reduced motion

Respect:

`prefers-reduced-motion`

Motion must never be required to understand or use the interface.

## Mobile quality

Mobile is a first-class experience.

Ensure:

- intentional narrow-screen composition;
- readable line lengths;
- comfortable spacing;
- large enough tap targets;
- no horizontal overflow;
- thoughtful form keyboard behaviour;
- imagery that still feels premium on small screens.

Do not merely shrink the desktop design.

## The Car Chapter Intake

The Intake should inherit the same visual world as the website.

It should feel like the beginning of the Chapter experience, not an external survey tool.

Prioritise:

- calm pacing;
- one clear decision at a time;
- meaningful whitespace;
- editorial typography;
- subtle progress;
- strong mobile ergonomics;
- minimal interface noise.

## Use of external design skills

External design skills such as Emil Kowalski, Taste or Impeccable may improve implementation quality.

However, they must not override:

- The Car Chapter's established visual direction;
- project-specific privacy requirements;
- established product decisions;
- scope constraints.

When uncertain, preserve the existing TCC identity rather than introducing novelty.

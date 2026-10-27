Lens: Bluebird — Design
Role id: bluebird. Challenge ids: DSN-<n>.
- Only screens. A design with none: clear.
- A screen is anything a person looks at or operates: a page, view, dialog or form. Read every section for one the design adds or changes.
- Read the repo's existing screens, stylesheets, theme files and components. That is the established look.
- A new color, type size, spacing, component or pattern with no stated reason, where the established look has one for the job → `defend`.
- A screen described with no reference to the established look, tokens or components → `unspecified`.
- Hierarchy: the one thing each screen is for, its primary action and the order of information. Two competing primaries, or the key information below the fold at phone width → `flaw`. Not stated → `unspecified`.
- Contrast to WCAG AA: 4.5:1 for text, 3:1 for large text, icons, borders and focus rings. Work out each pair from the repo's token values. A pair below → `flaw`; cite the tokens and the ratio. A color with no stated pair → `unspecified`.
- Meaning carried by color alone (status, error, selection) → `flaw`.
- Hover, focus, active and disabled states not drawn in the established style → `unspecified`.
- If the repo themes light and dark: a new color with one value only → `flaw`.
- Labels, terms and capitalisation that differ from the existing screens → `flaw`.

# Design

The visual contract for every surface in Hub. Read it before touching a `.tsx` file, `src/styles.css`,
or anything under `src/components`. The look is borrowed from Linear and Resend: one typeface, one
weight, a ladder of greys for emphasis, hairline borders, no shadows on flat content, and dense
controls. `src/typography-policy.test.ts` enforces the parts a regex can see; the rest is on you.

## Hard rules

1. **One weight.** Everything is 400. The only exception is `font-title`, and it goes on the one title
   of a surface: the page `h1`, a dialog or sheet title, the auth card title. Never on a section
   heading, a table header, a label, a button, a nav item, or a value. `font-medium`, `font-semibold`,
   `font-bold`, `<strong>`, `<b>`, and `fontWeight` do not exist here.
2. **Emphasis is colour, not weight.** Three text steps: `text-foreground` for what the reader came
   for, `text-muted-foreground` for context, `text-extra-muted-foreground` for decoration that can be
   missed. Pick one per element. A primary line over a muted line is how a record shows two facts.
3. **No letter-spacing.** No `tracking-*`, no `letter-spacing`. Inter is set at its default and stays
   there at every size.
4. **No uppercase.** No `uppercase`, no `text-transform`, no shouting labels. A small muted line in
   sentence case does the same job.
5. **Inter Variable, self-hosted.** Loaded once in `src/styles.entry.js`. Nothing sets `font-family`
   except the mono stack for code.
6. **The scale is the scale.** No `text-[Npx]`, no arbitrary sizes, no arbitrary colours. If a role
   has no size, the role is wrong, not the scale.
7. **Shared first.** A screen composes components from `src/components/app`. If a screen needs a
   shape that does not exist there, add it there and use it from the screen. Never hand-roll a card,
   field, table, empty state, pill, header, or key/value row in a panel file. Fix the component, not
   the leaf.

## Tokens

All tokens live in `src/styles.css`. Values come from Linear's measured ramp; Paseo green survives only
as the link and focus hue.

### Surfaces and text

| Token                     | Dark                  | Role                                                                                                                                             |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `background`              | `#08090a`             | The page, and the sidebar. The sidebar is not tinted.                                                                                            |
| `card`                    | `#0f1011`             | Bordered content: cards, tables, summary panels.                                                                                                 |
| `popover`                 | `#141516`             | Floating layers: menus, popovers, dialogs, command.                                                                                              |
| `muted`                   | `#141516`             | Inset fills: code blocks, segmented control track.                                                                                               |
| `accent`                  | `#191a1b`             | Hover and selected fill. Also `sidebar-accent`.                                                                                                  |
| `foreground`              | `#f7f8f8`             | Primary text.                                                                                                                                    |
| `muted-foreground`        | `#8a8f98`             | Secondary text: descriptions, meta, table headers, labels.                                                                                       |
| `extra-muted-foreground`  | `#62666d`             | Tertiary text: separators, placeholders, decorative marks. Below AA on purpose. Never for a value, an error, or anything the reader must act on. |
| `border`                  | `#23252a`             | Every structural rule. Near invisible; that is the point.                                                                                        |
| `input`                   | `#34343a`             | Control borders, one step stronger than `border`.                                                                                                |
| `primary` / `-foreground` | `#1b4f4a` / `#bfe6da` | A dark teal fill with a pale mint label; the one place the brand hue is a surface.                                                               |
| `link`                    | `#7ccba0`             | Text links and the focus ring. The one brand hue.                                                                                                |
| `ring`                    | `#7ccba0`             | Focus. One pixel outline, two pixel offset, nothing else.                                                                                        |
| `destructive`             | `#e8837a`             | Destructive button fill and error text.                                                                                                          |

Status tones (`success`, `warning`, `danger`, `neutral`) and their `-surface` pairs are unchanged and
are only ever read through `StatusPill`.

Light values mirror Linear's light ramp in the same file. The app currently renders dark only; keep the
light column correct anyway so a toggle is a one-line change.

### Type scale

Tailwind's size names are remapped in `@theme` so shadcn markup keeps reading normally while rendering
at Linear's density. Use the name for the role, not for the pixel.

| Utility     | Size / line | Role                                                                                                                                       |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `text-xs`   | 12 / 16     | Meta lines, pills, table headers, field descriptions, timestamps.                                                                          |
| `text-sm`   | 13 / 20     | The UI size. Body, cells, inputs, buttons, sidebar, section titles, descriptions. This is the `<body>` default; most elements set nothing. |
| `text-base` | 15 / 24     | Dialog and auth card titles. Long prose if a screen ever has any.                                                                          |
| `text-lg`   | 17 / 24     | Unused today. Do not reach for it to make something "a bit bigger".                                                                        |
| `text-xl`   | 20 / 28     | The page title. `PageHeader` owns it.                                                                                                      |
| `text-2xl`  | 24 / 32     | A figure: `StatTile` value, a price.                                                                                                       |
| `text-3xl`  | 32 / 36     | The largest figure. One per screen at most.                                                                                                |

`font-title` is the single elevated weight (500). `tabular-nums` on every number that sits in a
column — `DataTable` sets it for the whole table, so no cell decides this for itself.
`font-mono` for identifiers, URLs, keys, and code, always at `text-xs` or `text-sm`.

### Shape

| Token        | Value | Where                                                          |
| ------------ | ----- | -------------------------------------------------------------- |
| `rounded-sm` | 4px   | Pills, inline code, checkboxes.                                |
| `rounded-md` | 6px   | Controls: buttons, inputs, selects, menu items, sidebar items. |
| `rounded-lg` | 8px   | Floating layers: menus, popovers, dialogs.                     |
| `rounded-xl` | 12px  | Cards, tables, summary panels, the auth card.                  |

Borders are 1px `border` everywhere. Shadows exist only on floating layers, via `shadow-floating`.
Cards, tables, inputs, and buttons have none. Hover is a colour promotion (muted to foreground, or a
step of `accent` fill), never a shadow or a border change. Transitions are `150ms` on colour and
background only.

### Density

| Control                 | Size                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button default          | h-8, `text-sm`, px-3. `sm` h-7 `text-xs`. `xs` h-6. `lg` h-10. Icon sizes match.                                                                                                              |
| Input, select, combobox | h-8, `text-sm`, px-2.5.                                                                                                                                                                       |
| Menu item               | h-8, `text-sm`, `rounded-md`.                                                                                                                                                                 |
| Sidebar                 | 240px wide. Item h-8 `text-sm` `rounded-md`. Inactive `muted-foreground`; active `accent` fill and `foreground`. Hover promotes colour, no fill.                                              |
| Site header             | h-12, `border-b`, `background` fill, no blur. A route's own actions sit here from `sm`; a phone fits the sidebar trigger and the trail only, so the route puts the same controls in the page. |
| Table                   | Header row h-9 `text-xs muted-foreground`. Body row h-11 `text-sm`. Rows divided by `border`. Hover fill only on rows that navigate.                                                          |
| Card                    | p-6. `rounded-xl border bg-card`. Title `text-sm` foreground, description `text-sm muted-foreground`, gap-1 between them, gap-4 to the body.                                                  |
| Page column             | `max-w-5xl`, inset p-4 on phones and p-8 from `md`. Owned by the shell; screens never pad themselves.                                                                                         |
| Section                 | mb-8 between sections, gap-3 inside. Owned by `Section`.                                                                                                                                      |
| Field                   | gap-2 between label, control, and description. Fields in a form: gap-4.                                                                                                                       |

## Emphasis without weight

- A record is a primary line over a muted line at the same size. Use `TwoLine`.
- A group heading is `text-sm text-foreground` with its description in `muted-foreground` beneath it.
  It is not bigger and not heavier than the rows below it; it is set apart by the gap above it.
- Active navigation is a colour step at identical size and weight, plus the `accent` fill.
- A number that matters is bigger, not bolder: `text-2xl` and `tabular-nums`.
- A key/value pair is `text-xs muted-foreground` over `text-sm foreground`. Use `SummaryPanel`.
- Table headers are `text-xs muted-foreground` in sentence case. They are the quietest text in the
  table.

## Component roster

Everything a screen composes lives in `src/components/app`. The shadcn primitives in
`src/components/ui` are the raw material those components are built from; a screen file imports from
`ui` only for `Button`, `Input`, `Textarea`, `Select`, `Checkbox`, `Label`, and menu or dialog
primitives it is composing inside an app component. Anything else a screen wants from `ui` is a
missing app component.

| Component                                                               | The one way to                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Page`, `PageHeader`, `PageHeaderSkeleton`                              | Lay out a screen: the column, the one `h1`, its description, status, and actions.   |
| `Section`                                                               | Group content under a quiet heading with an optional trailing action.               |
| `Card`, `CardSkeleton`                                                  | Put content in a bordered surface. Title and description optional.                  |
| `DataTable`, `DataRow`, `DataCell`, `DataTableSkeleton`                 | List records.                                                                       |
| `TwoLine`                                                               | Show a primary fact over a muted secondary one, in a cell or a row.                 |
| `SummaryPanel`                                                          | Show labelled facts as a description list.                                          |
| `StatTile`, `StatGrid`                                                  | Show a figure with a label.                                                         |
| `StatusPill`                                                            | Show state. Never `Badge`, never a coloured span.                                   |
| `EmptyState`                                                            | Say there is nothing here and what to do about it.                                  |
| `FormField`, `FieldSkeleton`                                            | Label a control, with optional description and error. Wraps any control.            |
| `CheckboxField`                                                         | Label a checkbox beside its box, with what ticking it means underneath.             |
| `FormActions`                                                           | The button row under a form: stacks on phones, right-aligns from `sm`.              |
| `AuthForm`                                                              | A pre-auth form: fields, submit, optional secondary action, busy state.             |
| `AuthActions`                                                           | The buttons under a pre-auth card with no form left to submit. Never `FormActions`. |
| `FormDialog`                                                            | A dialog whose body is one form with one submit.                                    |
| `ConfirmAction`, `ConfirmMenuItem`                                      | Ask before something irreversible.                                                  |
| `FailureAlert`, `NoticeAlert`                                           | Show a failed request, or a neutral or success notice as a polite live region.      |
| `WarningAlert`                                                          | Warn without blocking.                                                              |
| `StatusLine`                                                            | A polite live region with reserved height.                                          |
| `Spinner`, `LoadingLine`, `PanelSkeleton`                               | Wait. Skeletons for pages, a spinner for one fact.                                  |
| `SegmentedControl`                                                      | Pick one of a few modes, with radio semantics.                                      |
| `TabNav`, `TabNavSkeleton`                                              | Navigate between sibling routes under one page.                                     |
| `Combobox`                                                              | Pick one of many with search.                                                       |
| `CopyField`, `CopyButton`, `CopyBlock`, `CodeBlock`                     | Show a value to copy, or a block of code.                                           |
| `Disclosure`                                                            | Open and close a bordered section.                                                  |
| `RowActions`                                                            | Put a record's actions behind one kebab.                                            |
| `RelativeTime`                                                          | Show when. There is no absolute-date formatter in screens.                          |
| `AuthLayout`, `AuthCard`, `AuthCardSkeleton`                            | Frame a pre-auth screen.                                                            |
| `SiteHeader`, `SiteHeaderActions`, `SidebarSwitcher`, `NavigationGroup` | The shell, in `src/shell`. Header actions render from `sm` up only.                 |

Rules for the roster:

- A component owns its spacing to its neighbours. Callers never add `mb-*` or `mt-*` to a shared
  component; if the rhythm is wrong, fix it in the component.
- Every skeleton lives next to the component it mirrors and shares its box.
- Every component has one visual result. If a caller passes `className` to change how it looks, the
  component is missing a prop or the caller is wrong. `className` is for placement in a grid only.
- Delete what nothing imports. Dead primitives in `ui` are deleted, not kept for later.

## Forbidden

- `font-*` weights other than `font-title`, and `font-title` outside a surface title.
- `tracking-*`, `uppercase`, `text-[…]`, hex colours in `.tsx`, `dark:` variants.
- `shadow-*` on anything that does not float.
- `Badge` for state. Raw `<pre>`, raw `<dl>`, raw `<table>`, raw `<details>` in a screen.
- A second implementation of anything in the roster, even a local one, even for one screen.
- `<h2>` or `<h3>` with a size class. Heading levels are semantic; `Section` and `Card` set the size.
- Margin on an `Alert`, a `Section`, or a `Card` from the outside.

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { DataCell, DataRow, DataTable, DataTableSkeleton, type DataColumn } from "./data-table.js";

const COLUMNS: readonly DataColumn[] = [
  { header: "Trigger" },
  { header: "Event" },
  { header: "Status" },
  { header: "", align: "end" },
];

const EMPTY = { title: "No triggers" };

function shell(markup: string): string {
  // Everything up to the first body row: the card, the column headers, the rails.
  return markup.slice(0, markup.indexOf("<tbody"));
}

describe("data table skeleton", () => {
  it("draws the same shell and columns as the table it stands in for", () => {
    const skeleton = renderToStaticMarkup(<DataTableSkeleton label="Triggers" columns={COLUMNS} />);
    const loaded = renderToStaticMarkup(
      <DataTable label="Triggers" columns={COLUMNS} isEmpty={false} empty={EMPTY}>
        <DataRow>
          {COLUMNS.map((column) => (
            <DataCell key={column.header}>{column.header}</DataCell>
          ))}
        </DataRow>
      </DataTable>,
    );

    assert.equal(
      shell(skeleton).slice(shell(skeleton).indexOf("<table")),
      shell(loaded).slice(shell(loaded).indexOf("<table")),
    );
  });

  it("announces itself busy and holds rows open at the loaded row height", () => {
    const markup = renderToStaticMarkup(
      <DataTableSkeleton label="Triggers" columns={COLUMNS} rows={2} />,
    );

    assert.match(markup, /aria-busy="true"/u);
    assert.equal(markup.match(/data-slot="skeleton"/gu)?.length, 2 * COLUMNS.length);
    assert.equal(markup.match(/h-11/gu)?.length, 2 * COLUMNS.length);
  });

  it("says nothing about having no records, which it does not yet know", () => {
    const markup = renderToStaticMarkup(<DataTableSkeleton label="Triggers" columns={COLUMNS} />);

    assert.doesNotMatch(markup, /No triggers/u);
  });

  it("drops the table entirely when there is nothing to list", () => {
    const markup = renderToStaticMarkup(
      <DataTable label="Triggers" columns={COLUMNS} isEmpty empty={EMPTY}>
        {null}
      </DataTable>,
    );

    assert.match(markup, /No triggers/u);
    assert.doesNotMatch(markup, /<table/u);
    assert.doesNotMatch(markup, /Trigger</u);
  });
});

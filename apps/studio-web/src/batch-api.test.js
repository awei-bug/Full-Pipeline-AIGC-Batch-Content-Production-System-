import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import { parseImportFile } from "./batch-api.js";

test("parseImportFile 可以解析 csv 文件为表头和商品行", async () => {
  const file = new File(
    [
      "商品名称,卖点,价格\n防晒喷雾,清爽不黏腻,89\n修护面膜,夜间补水修护,129",
    ],
    "products.csv",
    { type: "text/csv" },
  );

  const result = await parseImportFile(file);

  assert.equal(result.fileName, "products.csv");
  assert.deepEqual(result.headers, ["商品名称", "卖点", "价格"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].商品名称, "防晒喷雾");
});

test("parseImportFile 可以解析 xlsx 文件为表头和商品行", async () => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet([
    { 商品名称: "防晒喷雾", 卖点: "清爽不黏腻", 价格: 89 },
    { 商品名称: "修护面膜", 卖点: "夜间补水修护", 价格: 129 },
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "商品表");
  const workbookBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const file = new File([workbookBuffer], "products.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const result = await parseImportFile(file);

  assert.equal(result.fileName, "products.xlsx");
  assert.deepEqual(result.headers, ["商品名称", "卖点", "价格"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].卖点, "夜间补水修护");
});

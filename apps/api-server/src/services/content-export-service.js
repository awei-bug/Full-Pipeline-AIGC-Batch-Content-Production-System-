import ExcelJS from "exceljs";

const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function buildWorksheetRows(rows) {
  return rows.map((row) => ({
    productId: row.productId || "",
    productName: row.productName || "",
    marketingCopyTitle: row.marketingCopyTitle || "",
    videoScript: row.videoScript || "",
    imagePrompt: row.imagePrompt || "",
    imageUrl: row.imageUrl || "",
  }));
}

async function buildWorkbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("批量内容结果");

  worksheet.columns = [
    { header: "商品ID", key: "productId", width: 24 },
    { header: "商品名称", key: "productName", width: 24 },
    { header: "营销文案标题", key: "marketingCopyTitle", width: 32 },
    { header: "视频脚本", key: "videoScript", width: 50 },
    { header: "海报提示词", key: "imagePrompt", width: 50 },
    { header: "图片链接", key: "imageUrl", width: 42 },
  ];

  worksheet.addRows(buildWorksheetRows(rows));
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1D4ED8" },
  };

  worksheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: "top", wrapText: true };
    if (rowNumber > 1) {
      row.height = 36;
    }
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function createContentExportService({ repository }) {
  if (!repository) {
    throw new Error("Missing content jobs repository");
  }

  return {
    async exportJob(jobId) {
      const normalizedJobId = String(jobId || "").trim();
      if (!normalizedJobId) {
        throw new Error("Content export job id is required");
      }

      const rows = await repository.listExportRowsByJobId(normalizedJobId);
      const buffer = await buildWorkbookBuffer(rows);
      return {
        jobId: normalizedJobId,
        rows,
        buffer,
        fileName: `${normalizedJobId}-批量内容结果.xlsx`,
        contentType: EXCEL_CONTENT_TYPE,
      };
    },
  };
}

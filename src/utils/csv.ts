import path from 'path';
import fs from 'fs';

export class CsvManager {
  private filePath: string;
  private currentRow: number = 1;
  private rows: string[][] = [];

  constructor(fileName: string, outputDir: string = './output') {
    const resolvedOutputDir = process.env.OUTPUT_DIR ?? outputDir;
    if (!fs.existsSync(resolvedOutputDir)) {
      fs.mkdirSync(resolvedOutputDir, { recursive: true });
    }
    this.filePath = path.join(resolvedOutputDir, fileName);
    this.loadExistingCsv();
    this.currentRow = this.rows.length + 1;
  }

  /**
   * セルに値を書き込む (1-based row/col)
   */
  writeCell(row: number, col: number, value: string | number | Date): void {
    const r = row - 1;
    const c = col - 1;

    if (!this.rows[r]) this.rows[r] = [];
    this.rows[r][c] = this.toCsvValue(value);
  }

  /**
   * 文字列を強制テキスト書き込み (JANコード等の先頭ゼロ保護)
   */
  writeCellAsText(row: number, col: number, value: string): void {
    this.writeCell(row, col, value);
  }

  /**
   * 現在行を取得してインクリメント
   */
  nextRow(): number {
    return this.currentRow++;
  }

  /**
   * 現在の行番号を返す (インクリメントしない)
   */
  getCurrentRow(): number {
    return this.currentRow;
  }

  getRowCount(): number {
    return this.rows.length;
  }

  getColumnValues(col: number): string[] {
    const index = col - 1;
    return this.rows.map((row) => row[index] ?? '');
  }

  /**
   * BOM 付き UTF-8 の CSV ファイルを保存
   */
  async save(): Promise<void> {
    const csvText = this.rows
      .map((row) => row.map((cell) => this.escapeCsv(cell ?? '')).join(','))
      .join('\n');

    await fs.promises.writeFile(this.filePath, `\uFEFF${csvText}`, 'utf8');
    console.log(`[CSV] 保存完了: ${this.filePath}`);
  }

  getFilePath(): string {
    return this.filePath;
  }

  private toCsvValue(value: string | number | Date): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value ?? '');
  }

  private escapeCsv(value: string): string {
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  private loadExistingCsv(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const content = fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!content.trim()) {
      return;
    }

    this.rows = content
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => this.parseCsvLine(line));
  }

  private parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      const next = line[index + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          index++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current);
    return values;
  }
}
/**
 * Cadrel Finance's main-process half: the IPC surface for the Finance view, and the dialogs that save statements and calculators.
 * The money data is Market's library for now, reached through the shell-owned `AppService`; nothing here touches Market's own records
 * except reading which books are the studio's and asking Market to open one for capture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron';
import type { AppService } from '@cadrel/market-desktop/src/main/service.js';
import { CHANNELS } from '../shared/api.js';

// Tests run the real app but must not open a real file dialog or folder window.
export const TEST = process.env.CADREL_TEST === '1';

export interface FinanceHost {
  getWindow(): BrowserWindow | null;
  /** Finance's renderer: a view inside the shell window. */
  getContents(): WebContents | null;
  /** The library service Finance reads and writes through. */
  service: AppService;
}

export interface FinanceModule {
  /** Registers the IPC channels. */
  start(): void;
  /** Tells the view something changed under it (a capture or an import in Market) so it reloads. */
  notify(): void;
}

export function createFinanceModule(host: FinanceHost): FinanceModule {
  const { service } = host;
  const exportDir = () => (TEST ? process.env.CADREL_FINANCE_TEST_EXPORT_DIR : undefined);

  async function pickFolder(title: string): Promise<string | null> {
    if (TEST && process.env.CADREL_FINANCE_TEST_FOLDER) return process.env.CADREL_FINANCE_TEST_FOLDER;
    const r = await dialog.showOpenDialog(host.getWindow()!, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  }

  /** A page of HTML as a PDF, printed by a window that is never shown. */
  async function htmlToPdf(html: string): Promise<Buffer> {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    try {
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return await w.webContents.printToPDF({ pageSize: 'Letter', printBackground: false, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    } finally {
      w.destroy();
    }
  }

  /** Write a generated file (CSV, or a PDF printed from HTML) where the user chooses; PDFs for everyone go one per author into a chosen folder. */
  async function saveGenerated(kind: 'csv' | 'pdf', make: (payee: string | null) => { filename: string; content: string }, payee: string | null, everyone: () => string[]): Promise<string | null> {
    if (kind === 'pdf' && payee === null) {
      const dir = exportDir() ?? (await pickFolder('Choose a folder for the statements'));
      if (!dir) return null;
      for (const name of everyone()) {
        const f = make(name);
        fs.writeFileSync(path.join(dir, f.filename), await htmlToPdf(f.content));
      }
      return dir;
    }
    const f = make(payee);
    let target: string;
    const testDir = exportDir();
    if (testDir) target = path.join(testDir, f.filename);
    else {
      const r = await dialog.showSaveDialog(host.getWindow()!, { defaultPath: path.join(app.getPath('documents'), f.filename), filters: [{ name: kind === 'csv' ? 'Spreadsheet (CSV)' : 'PDF', extensions: [kind] }] });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, kind === 'csv' ? f.content : await htmlToPdf(f.content));
    if (!TEST) shell.showItemInFolder(target);
    return target;
  }

  const exportStatement = (from: string, to: string, kind: 'csv' | 'pdf', payee: string | null, basis: 'paid' | 'earned' = 'paid') =>
    saveGenerated(kind, (p) => service.statementFile(from, to, kind === 'csv' ? 'csv' : 'html', p, basis), payee, () => service.statement(from, to, basis).payees.map((p) => p.name));
  const exportPayment = (number: string, kind: 'csv' | 'pdf', payee: string | null) =>
    saveGenerated(kind, (p) => service.paymentFile(number, kind === 'csv' ? 'csv' : 'html', p), payee, () => service.paymentOwed(number).payees.map((p) => p.name));
  const exportRollup = (from: string, to: string, kind: 'csv' | 'pdf', payee: string | null) =>
    saveGenerated(kind, (p) => service.rollupFile(from, to, kind === 'csv' ? 'csv' : 'html', p), payee, () => service.payoutRollup(from, to).payees.filter((p) => p.due || p.owed || p.carriedIn).map((p) => p.name));

  const handlers: Record<string, (...a: any[]) => unknown> = {
    ready: () => !!service.status().libraryRoot,
    ownBooks: () => service.ownBooks(),
    openBook: (asin: string) => service.openBook(asin),
    exportStatement,
    exportPayment,
    exportRollup,
    salesStatus: (...a: unknown[]) => (service.salesStatus as (...x: unknown[]) => unknown)(...a),
    moneyMonths: (...a: unknown[]) => (service.moneyMonths as (...x: unknown[]) => unknown)(...a),
    moneyAnalysis: (...a: unknown[]) => (service.moneyAnalysis as (...x: unknown[]) => unknown)(...a),
    moneyMonth: (...a: unknown[]) => (service.moneyMonth as (...x: unknown[]) => unknown)(...a),
    people: (...a: unknown[]) => (service.people as (...x: unknown[]) => unknown)(...a),
    savePerson: (...a: unknown[]) => (service.savePerson as (...x: unknown[]) => unknown)(...a),
    deletePerson: (...a: unknown[]) => (service.deletePerson as (...x: unknown[]) => unknown)(...a),
    bookSplit: (...a: unknown[]) => (service.bookSplit as (...x: unknown[]) => unknown)(...a),
    allSplits: (...a: unknown[]) => (service.allSplits as (...x: unknown[]) => unknown)(...a),
    detectedAuthors: (...a: unknown[]) => (service.detectedAuthors as (...x: unknown[]) => unknown)(...a),
    setBookSplit: (...a: unknown[]) => (service.setBookSplit as (...x: unknown[]) => unknown)(...a),
    statement: (...a: unknown[]) => (service.statement as (...x: unknown[]) => unknown)(...a),
    payments: (...a: unknown[]) => (service.payments as (...x: unknown[]) => unknown)(...a),
    paymentOwed: (...a: unknown[]) => (service.paymentOwed as (...x: unknown[]) => unknown)(...a),
    allocatePayment: (...a: unknown[]) => (service.allocatePayment as (...x: unknown[]) => unknown)(...a),
    unallocatePayment: (...a: unknown[]) => (service.unallocatePayment as (...x: unknown[]) => unknown)(...a),
    payoutRollup: (...a: unknown[]) => (service.payoutRollup as (...x: unknown[]) => unknown)(...a),
    allocateRollup: (...a: unknown[]) => (service.allocateRollup as (...x: unknown[]) => unknown)(...a),
    payouts: (...a: unknown[]) => (service.payouts as (...x: unknown[]) => unknown)(...a),
    recordPayout: (...a: unknown[]) => (service.recordPayout as (...x: unknown[]) => unknown)(...a),
    deletePayout: (...a: unknown[]) => (service.deletePayout as (...x: unknown[]) => unknown)(...a),
    removePayment: (...a: unknown[]) => (service.removePayment as (...x: unknown[]) => unknown)(...a),
    setFxRate: (...a: unknown[]) => (service.setFxRate as (...x: unknown[]) => unknown)(...a),
    setKenpRate: (...a: unknown[]) => (service.setKenpRate as (...x: unknown[]) => unknown)(...a),
    importSales: (...a: unknown[]) => (service.importSales as (...x: unknown[]) => unknown)(...a),
    importRanks: (...a: unknown[]) => (service.importRanks as (...x: unknown[]) => unknown)(...a),
    calibrationPreview: (...a: unknown[]) => (service.calibrationPreview as (...x: unknown[]) => unknown)(...a),
    applyCalibration: (...a: unknown[]) => (service.applyCalibration as (...x: unknown[]) => unknown)(...a),
    setKenpc: (...a: unknown[]) => (service.setKenpc as (...x: unknown[]) => unknown)(...a),
    setKuCompletion: (...a: unknown[]) => (service.setKuCompletion as (...x: unknown[]) => unknown)(...a),
    resetCalibration: (...a: unknown[]) => (service.resetCalibration as (...x: unknown[]) => unknown)(...a),
    clearSalesData: (...a: unknown[]) => (service.clearSalesData as (...x: unknown[]) => unknown)(...a),
  };

  return {
    start() {
      for (const ch of CHANNELS) {
        ipcMain.handle(`finance:${ch}`, async (e, ...args) => {
          if (e.sender !== host.getContents()) throw new Error('not allowed');
          return handlers[ch]!(...args);
        });
      }
    },
    notify: () => host.getContents()?.send('finance:change')
  };
}

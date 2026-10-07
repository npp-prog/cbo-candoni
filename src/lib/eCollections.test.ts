import { describe, it, expect } from 'vitest';
import {
  collectionBelongsOnReport,
  isECollectionReportType,
  kindForReportType,
} from './eCollections';

/**
 * The division of one register between four reports.
 *
 * Every case below is a receipt reaching the ledger once or not at all, so
 * they are written out one by one rather than looped - a loop would have been
 * shorter and would not say which pairing each line is protecting.
 */
describe('which report a collection belongs on', () => {
  it('sends each electronic kind to its own COA annex', () => {
    expect(kindForReportType('ERCD_AR')).toBe('AR');
    expect(kindForReportType('ERCD_EOR')).toBe('EOR');
  });

  /*
   * Annex G was built in patch 91 and removed in patch 96. Candoni issues an
   * electronic Official Receipt when a payor pays the bank account directly,
   * so that money is an eOR collection and Annex G had nothing to report.
   */
  it('no longer knows a third report', () => {
    expect(kindForReportType('ERCD_DIRECT')).toBeUndefined();
    expect(isECollectionReportType('ERCD_DIRECT')).toBe(false);
  });

  it('answers null for the RCD, because that is an answer', () => {
    // The RCD gathers the collections with NO kind. Null is "the ones with no
    // kind", not "I do not know" - which is why it is distinguished from
    // undefined below.
    expect(kindForReportType('RCD')).toBeNull();
  });

  it('answers undefined for a report that does not gather collections at all', () => {
    expect(kindForReportType('RCI')).toBeUndefined();
    expect(kindForReportType('RADAI')).toBeUndefined();
    expect(kindForReportType('RCDISB')).toBeUndefined();
    expect(kindForReportType('')).toBeUndefined();
    expect(kindForReportType('SOMETHING_ELSE')).toBeUndefined();
  });

  it('recognises the two e-collection report types and nothing else', () => {
    expect(isECollectionReportType('ERCD_AR')).toBe(true);
    expect(isECollectionReportType('ERCD_EOR')).toBe(true);
    expect(isECollectionReportType('RCD')).toBe(false);
    expect(isECollectionReportType('ERCD')).toBe(false);
  });

  /*
   * Object.prototype is not a list of report types. Without hasOwnProperty the
   * lookup would answer true for 'constructor' and 'toString', and a report
   * carrying one of those as its type would have been accepted.
   */
  it('is not fooled by inherited property names', () => {
    expect(isECollectionReportType('constructor')).toBe(false);
    expect(isECollectionReportType('toString')).toBe(false);
    expect(isECollectionReportType('__proto__')).toBe(false);
    expect(kindForReportType('constructor')).toBeUndefined();
  });
});

describe('collectionBelongsOnReport', () => {
  it('puts a counter receipt on the RCD', () => {
    expect(collectionBelongsOnReport('RCD', null)).toBe(true);
    expect(collectionBelongsOnReport('RCD', undefined)).toBe(true);
    // A collection recorded before e-collections existed has no field at all.
    // It is a counter receipt, and it belongs on the RCD.
    expect(collectionBelongsOnReport('RCD', '')).toBe(true);
  });

  it('keeps electronic money off the RCD', () => {
    expect(collectionBelongsOnReport('RCD', 'AR')).toBe(false);
    expect(collectionBelongsOnReport('RCD', 'EOR')).toBe(false);
    expect(collectionBelongsOnReport('RCD', 'DIRECT')).toBe(false);
  });

  it('keeps counter money off the three annexes', () => {
    expect(collectionBelongsOnReport('ERCD_AR', null)).toBe(false);
    expect(collectionBelongsOnReport('ERCD_EOR', undefined)).toBe(false);
    expect(collectionBelongsOnReport('ERCD_DIRECT', null)).toBe(false);
  });

  it('matches each annex to its own kind and refuses the other', () => {
    expect(collectionBelongsOnReport('ERCD_AR', 'AR')).toBe(true);
    expect(collectionBelongsOnReport('ERCD_AR', 'EOR')).toBe(false);

    expect(collectionBelongsOnReport('ERCD_EOR', 'EOR')).toBe(true);
    expect(collectionBelongsOnReport('ERCD_EOR', 'AR')).toBe(false);
  });

  /**
   * A collection recorded under the kind that no longer exists is still real
   * money, and it belongs on the eOR report.
   *
   * Without this it would be reportable nowhere: the register would list it
   * and no report would accept it, so it would never reach the ledger and
   * nothing would say why. The alternative was a data migration over the
   * office's live records, which is a worse answer to a handful of rows.
   */
  it('reports a collection recorded as DIRECT on the eOR report', () => {
    expect(collectionBelongsOnReport('ERCD_EOR', 'DIRECT')).toBe(true);
    // And only there. It is not an intermediary's acknowledgement receipt and
    // it is certainly not a counter receipt.
    expect(collectionBelongsOnReport('ERCD_AR', 'DIRECT')).toBe(false);
    expect(collectionBelongsOnReport('RCD', 'DIRECT')).toBe(false);
    expect(collectionBelongsOnReport('ERCD_DIRECT', 'DIRECT')).toBe(false);
  });

  it('refuses a report type that gathers no collections, whatever the kind', () => {
    // A check report asking for a collection is a bug, not a special case, and
    // the engine must not quietly agree with it.
    expect(collectionBelongsOnReport('RCI', null)).toBe(false);
    expect(collectionBelongsOnReport('RCI', 'EOR')).toBe(false);
    expect(collectionBelongsOnReport('RCDISB', null)).toBe(false);
  });

  it('is case-sensitive about the kind, so a stray value is refused not guessed', () => {
    // 'eor' is not a kind CFMS writes. Accepting it would mean accepting
    // whatever an older or hand-edited document happened to carry.
    expect(collectionBelongsOnReport('ERCD_EOR', 'eor')).toBe(false);
  });
});

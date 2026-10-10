/**
 * Patch 158 - Payees and Employees become one master: NAMES.
 *
 * The municipality pays people, and some of those people are its own
 * officials and employees. Keeping them in two lists meant an employee was
 * entered twice - once to be paid on a voucher, once to be a collecting or
 * disbursing officer - and the two copies drifted (a TIN corrected in one, a
 * bank account in the other).
 *
 * Names is the one list. A name of type EMPLOYEE carries the employee's own
 * details too - employee number, name parts, position, employment type,
 * GSIS / PhilHealth / Pag-IBIG, monthly rate - entered on the same form.
 *
 * Underneath, the employee details are still mirrored to employees/{id}:
 * every screen that picks an officer (collecting officer, disbursing officer,
 * RAAF, cash advances) and every EMPLOYEE subsidiary ledger already posted
 * reads that record, and none of them has to change. The mirror is written by
 * the Names form only; the employees screen is gone.
 *
 * This file is the arithmetic: what the mirror holds, and how the employees
 * already on file are brought into Names without making a second copy of
 * someone who is already there as a payee.
 */

export const EMPLOYEE_FIELDS = [
  'employeeNumber',
  'lastName',
  'firstName',
  'middleName',
  'position',
  'employmentType',
  'gsisNumber',
  'philhealthNumber',
  'pagibigNumber',
  'monthlyRate',
] as const;

type Rec = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The employee record a Name of type EMPLOYEE keeps in step: its own id
 * (the Name's employeeId, else the Name's id), the employee fields, and the
 * shared ones - name, TIN, bank account - taken from the Name.
 */
export function employeeMirror(name: Rec, nameId: string): { id: string; data: Rec } {
  const id = str(name.employeeId) || nameId;
  const data: Rec = {
    id,
    payeeId: nameId,
    displayName: str(name.name),
    active: name.active ?? true,
  };
  // Only what the Name has: a blank here must not wipe what the employee
  // record already holds (the record is merged, not replaced).
  if (str(name.tin)) data.tin = str(name.tin);
  if (str(name.bankAccountNumber)) data.bankAccountNumber = str(name.bankAccountNumber);
  for (const k of EMPLOYEE_FIELDS) {
    const v = name[k];
    if (v !== undefined) data[k] = typeof v === 'string' ? v.trim() : v;
  }
  return { id, data };
}

/** "DELA CRUZ, Juan M." and "Juan M. Dela Cruz" read the same. */
export function nameKey(name: string): string {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** The same, without middle initials - "Juan Dela Cruz" finds "DELA CRUZ, Juan M.". */
export function looseNameKey(name: string): string {
  return nameKey(name)
    .split(' ')
    .filter((t) => t.length > 1)
    .join(' ');
}

export interface MergePlan {
  /** An employee already on Names as a payee: tie the two together. */
  links: Array<{ payeeId: string; employeeId: string }>;
  /** An employee not on Names at all: a Name is made for them, same id. */
  creates: Array<{ employeeId: string; name: Rec }>;
}

/**
 * The employees not yet on Names, and what to do with each.
 *
 * Matched to a payee by name (exactly, then without initials) - but only to a
 * payee not already tied to another employee, and only where exactly one
 * payee matches. Anything doubtful becomes a Name of its own: a duplicate
 * someone can see and deactivate is better than two people merged into one.
 */
export function planNameMerge(payees: Rec[], employees: Rec[]): MergePlan {
  const tied = new Set(payees.map((p) => str(p.employeeId)).filter(Boolean));
  const payeeIds = new Set(payees.map((p) => str(p.id)));
  const free = payees.filter((p) => !str(p.employeeId));
  const index = (key: (n: string) => string) => {
    const m = new Map<string, Rec[]>();
    for (const p of free) {
      const k = key(str(p.name));
      if (!k) continue;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  };
  const exact = index(nameKey);
  const loose = index(looseNameKey);
  const used = new Set<string>();

  const plan: MergePlan = { links: [], creates: [] };
  for (const e of employees) {
    const eid = str(e.id);
    if (!eid || tied.has(eid)) continue;
    if (str(e.payeeId) && payeeIds.has(str(e.payeeId))) continue;

    const full = [str(e.firstName), str(e.middleName), str(e.lastName)].filter(Boolean).join(' ');
    const candidates = [str(e.displayName), full].filter(Boolean);
    let match: Rec | null = null;
    for (const [m, key] of [
      [exact, nameKey],
      [loose, looseNameKey],
    ] as const) {
      for (const c of candidates) {
        const hits = (m.get(key(c)) ?? []).filter((p) => !used.has(str(p.id)));
        if (hits.length === 1) {
          match = hits[0];
          break;
        }
      }
      if (match) break;
    }

    if (match) {
      used.add(str(match.id));
      plan.links.push({ payeeId: str(match.id), employeeId: eid });
    } else {
      plan.creates.push({
        employeeId: eid,
        name: {
          id: eid,
          name: str(e.displayName) || full,
          payeeType: 'EMPLOYEE',
          employeeId: eid,
          tin: str(e.tin) || null,
          bankAccountNumber: str(e.bankAccountNumber) || null,
          active: e.active ?? true,
          ...Object.fromEntries(
            EMPLOYEE_FIELDS.filter((k) => e[k] !== undefined && e[k] !== null).map((k) => [
              k,
              e[k],
            ]),
          ),
        },
      });
    }
  }
  return plan;
}

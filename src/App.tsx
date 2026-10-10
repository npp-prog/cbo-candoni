import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { AppShell } from './layout/AppShell';
import { SignIn, AwaitingAccess } from './pages/SignIn';
import { Spinner, EmptyState } from './components/ui/Layout';
import { Button } from './components/ui/Button';
import type { Action, Module } from './types/system';
// Patch 136: small and needed by five routes, so imported directly rather than lazily.
import { TrustFundOnly } from './pages/accounting/trustTabs';

/**
 * Routing.
 *
 * Route modules are lazily loaded so the initial bundle stays small - a
 * municipal office on a shared connection should not download the bank
 * reconciliation workspace in order to see the dashboard.
 *
 * `<Guard>` hides screens a role has no business seeing. It is a usability
 * control only: the data behind those screens is protected by Firestore
 * Security Rules, which apply whether or not this component rendered.
 */

const Dashboard = lazy(() => import('./pages/Dashboard'));

const Appropriations = lazy(() => import('./pages/budget/Appropriations'));
const BudgetPrograms = lazy(() => import('./pages/budget/BudgetPrograms'));
const Ordinances = lazy(() => import('./pages/budget/Ordinances'));
const OrdinanceDetail = lazy(() => import('./pages/budget/OrdinanceDetail'));
const Allotments = lazy(() => import('./pages/budget/Allotments'));
const EstimatedReceipts = lazy(() => import('./pages/budget/EstimatedReceipts'));
const TrustPrograms = lazy(() => import('./pages/accounting/TrustPrograms'));
const FundUtilization = lazy(() => import('./pages/reports/FundUtilization'));
const Obligations = lazy(() => import('./pages/budget/Obligations'));
const ObligationDetail = lazy(() => import('./pages/budget/ObligationDetail'));
const BudgetRegistry = lazy(() => import('./pages/budget/Registry'));
const BudgetUpload = lazy(() => import('./pages/budget/BudgetUpload'));

const Disbursements = lazy(() => import('./pages/accounting/Disbursements'));
const DisbursementDetail = lazy(() => import('./pages/accounting/DisbursementDetail'));
const Jevs = lazy(() => import('./pages/accounting/Jevs'));
const JevDetail = lazy(() => import('./pages/accounting/JevDetail'));
const JevAppendix30 = lazy(() => import('./pages/accounting/JevAppendix30'));
const DvPayeeListPrint = lazy(() => import('./pages/accounting/PayeeList'));
const JournalEntriesRegister = lazy(() => import('./pages/accounting/JournalEntriesRegister'));
const Checks = lazy(() => import('./pages/treasury/Checks'));
const TreasuryDisbursements = lazy(() => import('./pages/treasury/Disbursements'));
const AdaPage = lazy(() => import('./pages/treasury/Ada'));
const BankCredits = lazy(() => import('./pages/treasury/BankCredits'));
const TreasuryReportRegister = lazy(() => import('./pages/treasury/TreasuryReports'));
const TreasuryReportDetail = lazy(() => import('./pages/treasury/TreasuryReportDetail'));
const TreasuryReportForm = lazy(() => import('./pages/treasury/TreasuryReportForm'));
const AdaAppendix36 = lazy(() => import('./pages/treasury/AdaAppendix36'));
const PaymentUploads = lazy(() => import('./pages/treasury/PaymentUploads'));
const AbstractUpload = lazy(() => import('./pages/treasury/AbstractUpload'));
const TreasuryReportJev = lazy(() => import('./pages/accounting/TreasuryReportJev'));
const Payroll = lazy(() => import('./pages/treasury/Payroll'));
const PayrollDetail = lazy(() => import('./pages/treasury/PayrollDetail'));
const CashAdvances = lazy(() => import('./pages/accounting/CashAdvances'));
const FdppReports = lazy(() => import('./pages/accounting/FdppReports'));
const Liquidation = lazy(() => import('./pages/accounting/Liquidation'));
const LiquidationDetail = lazy(() => import('./pages/accounting/LiquidationDetail'));
const IndexOfPayments = lazy(() => import('./pages/accounting/IndexOfPayments'));

const TreasuryCollections = lazy(() => import('./pages/treasury/Collections'));
const ECollections = lazy(() => import('./pages/treasury/ECollections'));
const ECollectionReports = lazy(() => import('./pages/treasury/ECollectionReports'));
const Rcd = lazy(() => import('./pages/treasury/Rcd'));
const Deposits = lazy(() => import('./pages/treasury/Deposits'));
const Remittances = lazy(() => import('./pages/treasury/Remittances'));
const CashPosition = lazy(() => import('./pages/treasury/CashPosition'));
const AccountableForms = lazy(() => import('./pages/treasury/AccountableForms'));
const RcdAppendix34 = lazy(() => import('./pages/treasury/RcdAppendix34'));
const PrimaryAppendix34 = lazy(() => import('./pages/treasury/PrimaryAppendix34'));
const AbstractOfCollections = lazy(() => import('./pages/reports/AbstractOfCollections'));
const SummaryOfCollections = lazy(() => import('./pages/reports/SummaryOfCollections'));
const RcdTransmittal = lazy(() => import('./pages/reports/RcdTransmittal'));
const CancelledChecks = lazy(() => import('./pages/reports/CancelledChecks'));
const ClaimSheet = lazy(() => import('./pages/treasury/ClaimSheet'));
const CashInBank = lazy(() => import('./pages/treasury/CashInBank'));
const PrintChecks = lazy(() => import('./pages/treasury/PrintChecks'));
const PrintReceipt = lazy(() => import('./pages/treasury/PrintReceipt'));
const CashInLocalTreasury = lazy(() => import('./pages/reports/CashInLocalTreasury'));
const Raaf = lazy(() => import('./pages/treasury/Raaf'));

const BankReconciliation = lazy(() => import('./pages/reconciliation/BankReconciliation'));

const ReportsHome = lazy(() => import('./pages/reports/ReportsHome'));
const TrialBalance = lazy(() => import('./pages/reports/TrialBalance'));
const FinancialStatements = lazy(() => import('./pages/reports/FinancialStatements'));
const Saob = lazy(() => import('./pages/reports/Saob'));
const GeneralLedger = lazy(() => import('./pages/reports/GeneralLedger'));
const SubsidiaryLedger = lazy(() => import('./pages/reports/SubsidiaryLedger'));
const Journals = lazy(() => import('./pages/reports/Journals'));
const Registers = lazy(() => import('./pages/reports/Registers'));
const Aging = lazy(() => import('./pages/reports/Aging'));
const BudgetVsActual = lazy(() => import('./pages/reports/BudgetVsActual'));
const Sre = lazy(() => import('./pages/reports/Sre'));
const QuarterlyFinancialReport = lazy(() => import('./pages/reports/QuarterlyFinancialReport'));
const QuarterlyReceipts = lazy(() => import('./pages/reports/QuarterlyReceipts'));
const OpeningBalances = lazy(() => import('./pages/reports/OpeningBalances'));
const TreasuryReports = lazy(() => import('./pages/reports/TreasuryReports'));

const MasterData = lazy(() => import('./pages/masterdata/MasterData'));
const ChartUpload = lazy(() => import('./pages/masterdata/ChartUpload'));
const Raao = lazy(() => import('./pages/budget/Raao'));
const Reairr = lazy(() => import('./pages/budget/Reairr'));
const Rstf = lazy(() => import('./pages/accounting/Rstf'));
const UnreleasedChecks = lazy(() => import('./pages/treasury/UnreleasedChecks'));
const CashAdvanceBook = lazy(() => import('./pages/treasury/CashAdvanceBook'));
const RptAbstract = lazy(() => import('./pages/reports/RptAbstract'));
const Scbaa = lazy(() => import('./pages/reports/Scbaa'));
const Documents = lazy(() => import('./pages/Documents'));
const ChangePassword = lazy(() => import('./pages/ChangePassword'));
const Users = lazy(() => import('./pages/admin/Users'));
const Periods = lazy(() => import('./pages/admin/Periods'));
const Numbering = lazy(() => import('./pages/admin/Numbering'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const AuditTrail = lazy(() => import('./pages/AuditTrail'));
const Notifications = lazy(() => import('./pages/Notifications'));

export default function App() {
  const { user, loading, awaitingAccess } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Spinner label="Starting CFMS" />
      </div>
    );
  }

  if (!user) return <SignIn />;
  if (awaitingAccess) return <AwaitingAccess />;

  return (
    <AppShell>
      <Suspense fallback={<Spinner label="Loading" />}>
        <Routes>
          <Route path="/" element={<Guard module="dashboard"><Dashboard /></Guard>} />

          {/* Budget */}
          <Route path="/budget" element={<Navigate to="/budget/obligations" replace />} />
          <Route path="/budget/appropriations" element={<Guard module="budget"><Appropriations /></Guard>} />
          {/* The programmes the ordinance appropriated to, per year. A tab
              beside the appropriations rather than a Master Data screen: it is
              read and added to WHILE an appropriation is being encoded, not
              months earlier in a different part of the menu. */}
          <Route
            path="/budget/appropriations/programmes"
            element={<Guard module="budget"><BudgetPrograms /></Guard>}
          />
          {/* The ordinances, each a document of its own (patch 119): recorded
              first, its lines recorded inside it, the signed copy attached,
              LBP Form No. 2 printed, then approved whole. */}
          <Route
            path="/budget/appropriations/ordinances"
            element={<Guard module="budget"><Ordinances /></Guard>}
          />
          <Route
            path="/budget/appropriations/ordinances/:id"
            element={<Guard module="budget"><OrdinanceDetail /></Guard>}
          />
          {/* The financing side. The ordinance carries only expenditure, so
              without this no statement has a budget column for receipts. */}
          <Route
            path="/budget/estimated-receipts"
            element={<Guard module="budget"><EstimatedReceipts /></Guard>}
          />
          <Route path="/budget/allotments" element={<Guard module="budget"><Allotments /></Guard>} />
          {/* One screen, no tabs. The register and the release orders are one
              page now, so both old addresses land on it - an officer's
              bookmark from either of them still arrives somewhere useful. */}
          <Route
            path="/budget/allotments/orders"
            element={<Navigate to="/budget/allotments" replace />}
          />
          <Route
            path="/budget/release-orders"
            element={<Navigate to="/budget/allotments" replace />}
          />
          <Route
            path="/budget/appropriations/upload"
            element={<Guard module="budget"><BudgetUpload kind="APPROPRIATION" /></Guard>}
          />
          <Route
            path="/budget/allotments/upload"
            element={<Guard module="budget"><BudgetUpload kind="ALLOTMENT" /></Guard>}
          />
          <Route path="/budget/obligations" element={<Guard module="budget"><Obligations /></Guard>} />
          <Route path="/budget/obligations/new" element={<Guard module="budget" action="create"><ObligationDetail /></Guard>} />
          <Route path="/budget/obligations/:id" element={<Guard module="budget"><ObligationDetail /></Guard>} />
          <Route path="/budget/registry" element={<Guard module="budget"><BudgetRegistry /></Guard>} />
          {/*
            The four statutory registries, GAM Appendices 19-22. One screen
            behind four addresses: the instruction sheets are identical apart
            from the allotment class, so the class is the route segment.
          */}
          <Route path="/budget/registry/:slug" element={<Guard module="budget"><Raao /></Guard>} />
          {/* Appendix 23: the income side of the same pair of books. */}
          <Route path="/budget/registry-income" element={<Guard module="budget"><Reairr /></Guard>} />
          {/* Appendix 18. Accounting's book, not the Budget Office's. */}
          <Route path="/accounting/trust-registry" element={<Guard module="accounting"><TrustFundOnly><Rstf /></TrustFundOnly></Guard>} />
          {/* Patch 136: Accounting > Trust Accounts > FURS - the obligation register, for the Trust Fund. */}
          <Route path="/accounting/furs" element={<Guard module="accounting"><TrustFundOnly><Obligations trust /></TrustFundOnly></Guard>} />
          <Route path="/accounting/furs/new" element={<Guard module="budget" action="create"><TrustFundOnly><ObligationDetail /></TrustFundOnly></Guard>} />
          <Route path="/accounting/furs/:id" element={<Guard module="accounting"><TrustFundOnly><ObligationDetail /></TrustFundOnly></Guard>} />
          {/* Appendix 42, drawn off the check register it sits beside. */}
          <Route path="/treasury/checks/unreleased" element={<Guard module="treasury"><UnreleasedChecks /></Guard>} />
          {/* Appendix 26, the third cash book beside Cash in Bank and Cash in Treasury. */}
          <Route path="/treasury/cash-advance-book" element={<Guard module="treasury"><CashAdvanceBook /></Guard>} />
          <Route path="/reports/rpt-abstract" element={<Guard module="reports"><RptAbstract /></Guard>} />

          {/* Accounting */}
          <Route path="/accounting" element={<Navigate to="/accounting/disbursements" replace />} />
          <Route path="/accounting/disbursements" element={<Guard module="accounting"><Disbursements /></Guard>} />
          <Route path="/accounting/disbursements/new" element={<Guard module="accounting" action="create"><DisbursementDetail /></Guard>} />
          {/* Patch 140: the List of Payees of a group voucher - before the
              detail route, which would otherwise read "payees" as part of it. */}
          <Route
            path="/accounting/disbursements/:id/payees"
            element={<Guard module="accounting"><DvPayeeListPrint /></Guard>}
          />
          <Route path="/accounting/disbursements/:id" element={<Guard module="accounting"><DisbursementDetail /></Guard>} />
          {/* "Others": manual, adjusting, closing and prior-period entries - the
              journal entries that begin in Accounting rather than arriving on a
              voucher or a treasury report. The /accounting/jev paths still
              resolve so older links and notifications keep working. */}
          <Route path="/accounting/general-transactions" element={<Guard module="accounting"><Jevs /></Guard>} />
          <Route path="/accounting/general-transactions/new" element={<Guard module="accounting" action="create"><JevDetail /></Guard>} />
          <Route path="/accounting/general-transactions/:id" element={<Guard module="accounting"><JevDetail /></Guard>} />
          {/* The screen was called "Other Transactions" until patch 78. Old
              addresses still land, including the ones in notifications and in
              the audit trail, which carry a link per entry. */}
          <Route path="/accounting/others" element={<Navigate to="/accounting/general-transactions" replace />} />
          <Route path="/accounting/others/:id" element={<RedirectToGeneralTransaction />} />
          <Route
            path="/accounting/journal-entries"
            element={<Guard module="accounting"><JournalEntriesRegister /></Guard>}
          />
          <Route
            path="/accounting/journal-entries/:id"
            element={<Guard module="accounting"><JevDetail /></Guard>}
          />
          <Route path="/accounting/jev" element={<Navigate to="/accounting/general-transactions" replace />} />
          <Route path="/accounting/jev/:id" element={<Guard module="accounting"><JevDetail /></Guard>} />
          {/* The entry as COA prints it. A page of its own rather than a print
              stylesheet over the working screen: the two share no layout at
              all, and a form that is a hidden copy of a screen drifts from it
              the first time the screen changes. */}
          <Route
            path="/accounting/jev/:id/print"
            element={<Guard module="accounting"><JevAppendix30 /></Guard>}
          />
          {/* Checks and ADA are Treasury's work: the Treasurer draws them against a
              completed voucher. They live under /treasury and are guarded by the
              treasury module. The old /accounting paths redirect so that links in
              older documents, notifications and bookmarks still resolve. */}
          {/* Approved vouchers waiting for the Treasurer. The act of paying
              belongs here, not on the Accounting voucher screen. */}
          <Route path="/treasury/disbursements" element={<Guard module="treasury"><TreasuryDisbursements /></Guard>} />
          <Route path="/treasury/checks" element={<Guard module="treasury"><Checks /></Guard>} />
          <Route path="/treasury/checks/:id" element={<Guard module="treasury"><Checks /></Guard>} />
          <Route path="/treasury/ada" element={<Guard module="treasury"><AdaPage /></Guard>} />
          {/* The series and the holes in it. A number, once drawn, is never
              returned to the pool - so every hole needs an explanation. */}
          {/* The number series is now a tab inside the ADA screen. Kept as a
              redirect so an old bookmark or notification link still lands. */}
          <Route path="/treasury/ada/numbers" element={<Navigate to="/treasury/ada" replace />} />
          {/* The printed form comes BEFORE the detail route, which would
              otherwise read "form" as an advice id. */}
          <Route
            path="/treasury/ada/:id/form"
            element={<Guard module="treasury"><AdaAppendix36 /></Guard>}
          />
          {/* Patch 144: the RADAI's Bank Credits - before the advice id route. */}
          <Route
            path="/treasury/ada/bank-credits"
            element={<Guard module="treasury"><BankCredits /></Guard>}
          />
          <Route path="/treasury/ada/:id" element={<Guard module="treasury"><AdaPage /></Guard>} />
          {/* The four treasury reports share one screen, distinguished by the
              type passed in. They are one document with four contents: the
              Treasurer certifies a list, Accounting journalizes it. */}
          <Route
            path="/treasury/checks/uploads"
            element={<Guard module="treasury"><PaymentUploads importType="RCI" /></Guard>}
          />
          <Route
            path="/treasury/ada/uploads"
            element={<Guard module="treasury"><PaymentUploads importType="RADAI" /></Guard>}
          />
          <Route
            path="/treasury/checks/rci"
            element={<Guard module="treasury"><TreasuryReportRegister reportType="RCI" /></Guard>}
          />
          <Route
            path="/treasury/ada/radai"
            element={<Guard module="treasury"><TreasuryReportRegister reportType="RADAI" /></Guard>}
          />
          <Route
            path="/treasury/collections/rcd"
            element={<Guard module="treasury"><TreasuryReportRegister reportType="RCD" /></Guard>}
          />
          <Route
            path="/treasury/payroll/rcdisb"
            element={<Guard module="treasury"><TreasuryReportRegister reportType="RCDISB" /></Guard>}
          />
          {/* Annexes E, F and G of COA Circular 2021-014 behind one address.
              They are three reports and stay three; the choice of which is
              made on the page. See ECollectionReports. */}
          <Route
            path="/treasury/collections/ercd"
            element={<Guard module="treasury"><ECollectionReports /></Guard>}
          />
          {/* One report, on a page of its own, so it can carry the signed
              form. One address for all four kinds: the report says which it
              is, and four routes to one screen would be four things to keep
              in step. */}
          {/* Before the detail route, for the same reason as the ADA above. */}
          <Route
            path="/treasury/reports/:id/form"
            element={<Guard module="treasury"><TreasuryReportForm /></Guard>}
          />
          <Route
            path="/treasury/reports/:id"
            element={<Guard module="treasury"><TreasuryReportDetail /></Guard>}
          />
          <Route
            path="/accounting/treasury-reports"
            element={<Guard module="accounting"><TreasuryReportJev /></Guard>}
          />
          <Route
            path="/accounting/treasury-reports/:id"
            element={<Guard module="accounting"><TreasuryReportJev /></Guard>}
          />
          <Route path="/accounting/checks" element={<Navigate to="/treasury/checks" replace />} />
          <Route path="/accounting/checks/:id" element={<Navigate to="/treasury/checks" replace />} />
          <Route path="/accounting/ada" element={<Navigate to="/treasury/ada" replace />} />
          <Route path="/accounting/ada/:id" element={<Navigate to="/treasury/ada" replace />} />
          {/* Payroll is Treasury's: the payroll officer disburses it and reports
              the cash paid on an RCDisb. */}
          <Route path="/treasury/payroll" element={<Guard module="treasury"><Payroll /></Guard>} />
          {/* Patch 155: a payroll on its own page. "rcdisb" above is a fixed path and wins over :id. */}
          <Route path="/treasury/payroll/new" element={<Guard module="treasury" action="create"><PayrollDetail /></Guard>} />
          <Route path="/treasury/payroll/:id" element={<Guard module="treasury"><PayrollDetail /></Guard>} />
          <Route path="/accounting/payroll" element={<Navigate to="/treasury/payroll" replace />} />
          <Route path="/accounting/cash-advances" element={<Guard module="accounting"><CashAdvances /></Guard>} />
          <Route path="/accounting/fdpp" element={<Guard module="accounting"><FdppReports /></Guard>} />
          <Route path="/accounting/liquidation" element={<Guard module="accounting"><Liquidation /></Guard>} />
          <Route
            path="/accounting/liquidation/new"
            element={<Guard module="accounting" action="create"><LiquidationDetail /></Guard>}
          />
          <Route
            path="/accounting/liquidation/:id"
            element={<Guard module="accounting"><LiquidationDetail /></Guard>}
          />
          <Route path="/accounting/index-of-payments" element={<Guard module="accounting"><IndexOfPayments /></Guard>} />

          {/* Treasury */}
          <Route path="/treasury" element={<Navigate to="/treasury/collections" replace />} />
          <Route path="/treasury/collections" element={<Guard module="treasury"><TreasuryCollections /></Guard>} />
          <Route
            path="/treasury/collections/upload"
            element={<Guard module="treasury"><AbstractUpload /></Guard>}
          />
          {/* Money that arrived without anybody handing cash over a counter.
              Inside the collections section, not beside it: it IS a
              collection, and the reasons are on Collection.eCollectionKind. */}
          <Route
            path="/treasury/collections/electronic"
            element={<Guard module="treasury"><ECollections /></Guard>}
          />
          <Route path="/treasury/rcd" element={<Guard module="treasury"><Rcd /></Guard>} />
          <Route path="/treasury/rcd/:id" element={<Guard module="treasury"><Rcd /></Guard>} />
          {/* The RCD as COA prints it. Separate from the register because the
              register is how the office works and this is what it signs. */}
          <Route
            path="/treasury/collections/rcd/:id/form"
            element={<Guard module="treasury"><RcdAppendix34 /></Guard>}
          />
          {/* The layer above the collector's own report: the Liquidating
              Officer gathers several secondaries into one primary, and
              closing it is what freezes them. */}
          {/* The two layers above a collector's own report, one screen each
              way. The old address still arrives at the first of them. */}
          {/* Patch 156: the Collector's Report and the Consolidated Collection
              Report are removed. Their old addresses land on the RCD. */}
          <Route
            path="/treasury/collections/collectors"
            element={<Navigate to="/treasury/collections/rcd" replace />}
          />
          <Route
            path="/treasury/collections/consolidated"
            element={<Navigate to="/treasury/collections/rcd" replace />}
          />
          <Route
            path="/treasury/collections/primary"
            element={<Navigate to="/treasury/collections/rcd" replace />}
          />
          <Route
            path="/treasury/collections/primary/:id/form"
            element={<Guard module="treasury"><PrimaryAppendix34 /></Guard>}
          />
          {/* Deposits sit inside the collections section. The old address is
              kept as a redirect so bookmarks and older notifications still
              land somewhere sensible. */}
          <Route path="/treasury/collections/deposits" element={<Guard module="treasury"><Deposits /></Guard>} />
          <Route path="/treasury/collections/remittances" element={<Guard module="treasury"><Remittances /></Guard>} />
          <Route path="/treasury/deposits" element={<Navigate to="/treasury/collections/deposits" replace />} />
          <Route path="/treasury/cash-position" element={<Guard module="treasury"><CashPosition /></Guard>} />
          {/* The running book for one account, as against the Cash Position
              screen, which is a snapshot across all of them. */}
          <Route path="/treasury/cash-in-bank" element={<Guard module="treasury"><CashInBank /></Guard>} />
          <Route path="/treasury/print/checks" element={<Guard module="treasury"><PrintChecks /></Guard>} />
          <Route path="/treasury/print/receipts" element={<Guard module="treasury"><PrintReceipt /></Guard>} />
          {/* Printed empty and filled in at the counter: the signature is the
              document. */}
          <Route path="/treasury/claim-sheet" element={<Guard module="treasury"><ClaimSheet /></Guard>} />
          {/* Custody of the municipality's numbered paper, and the monthly
              report that proves it. The RAAF is reachable from Reports as well,
              because COA reads it as a report even though the Treasurer's
              office works on it as a register. */}
          <Route
            path="/treasury/accountable-forms"
            element={<Guard module="treasury"><AccountableForms /></Guard>}
          />
          <Route path="/treasury/raaf" element={<Guard module="treasury"><Raaf /></Guard>} />

          {/* Reconciliation */}
          <Route path="/reconciliation" element={<Navigate to="/reconciliation/bank" replace />} />
          <Route path="/reconciliation/bank" element={<Guard module="reconciliation"><BankReconciliation /></Guard>} />
          <Route path="/reconciliation/bank/:id" element={<Guard module="reconciliation"><BankReconciliation /></Guard>} />

          {/* Reports */}
          <Route path="/reports" element={<Guard module="reports"><ReportsHome /></Guard>} />
          <Route path="/reports/trial-balance" element={<Guard module="reports"><TrialBalance /></Guard>} />
          <Route path="/reports/financial-statements" element={<Guard module="reports"><FinancialStatements /></Guard>} />
          <Route path="/reports/saob" element={<Guard module="reports"><Saob /></Guard>} />
          <Route path="/reports/general-ledger" element={<Guard module="reports"><GeneralLedger /></Guard>} />
          <Route path="/reports/subsidiary-ledger" element={<Guard module="reports"><SubsidiaryLedger /></Guard>} />
          <Route path="/reports/journals" element={<Guard module="reports"><Journals /></Guard>} />
          <Route path="/reports/registers" element={<Guard module="reports"><Registers /></Guard>} />
          <Route path="/reports/aging" element={<Guard module="reports"><Aging /></Guard>} />
          {/* GAM Annex 8, the statement that is submitted. */}
          <Route
            path="/reports/budget-vs-actual"
            element={<Guard module="reports"><Scbaa /></Guard>}
          />
          {/* CFMS's own control report: the budget module beside the ledger. */}
          <Route
            path="/reports/budget-vs-actual/lines"
            element={<Guard module="reports"><BudgetVsActual /></Guard>}
          />
          {/* The Local Budget Accountability reports. They live under Budget
              because they account for the budget; the Reports menu holds the
              statements drawn off the books. Only the three the municipality
              files are built - LBAc 3, 5 and 6 want physical targets CFMS does
              not hold, and a shell of one would invite a half-filled
              submission. */}
          <Route
            path="/budget/reports/receipts"
            element={<Guard module="budget"><QuarterlyReceipts /></Guard>}
          />
          <Route
            path="/budget/reports/quarterly-financial"
            element={<Guard module="budget"><QuarterlyFinancialReport /></Guard>}
          />
          <Route path="/budget/reports/sre" element={<Guard module="budget"><Sre /></Guard>} />
          {/* They used to sit under Reports. Anything already linking there -
              a bookmark, an older runbook - still arrives. */}
          <Route path="/reports/sre" element={<Navigate to="/budget/reports/sre" replace />} />
          <Route
            path="/reports/quarterly-financial"
            element={<Navigate to="/budget/reports/quarterly-financial" replace />}
          />
          {/* The Trust Fund's funding control. Accounting's, not Budget's:
              there is no ordinance behind a trust programme. */}
          <Route
            path="/accounting/trust-programs"
            element={<Guard module="accounting"><TrustFundOnly><TrustPrograms /></TrustFundOnly></Guard>}
          />
          <Route
            path="/accounting/fund-utilization"
            element={<Guard module="accounting"><TrustFundOnly><FundUtilization /></TrustFundOnly></Guard>}
          />
          <Route
            path="/accounting/opening-balances"
            element={<Guard module="accounting"><OpeningBalances /></Guard>}
          />
          {/* The screen used to live under Reports. Anything already linking
              there - a bookmark, an older runbook - still arrives. */}
          <Route
            path="/reports/trial-balance/opening"
            element={<Navigate to="/accounting/opening-balances" replace />}
          />
          <Route path="/reports/treasury" element={<Guard module="reports"><TreasuryReports /></Guard>} />
          <Route
            path="/reports/abstract-of-collections"
            element={<Guard module="reports"><AbstractOfCollections /></Guard>}
          />
          {/* The same abstract over the electronic receipts only - a cut of
              the general one, not a second report. See AbstractOfCollections. */}
          <Route
            path="/reports/abstract-of-e-collections"
            element={<Guard module="reports"><AbstractOfCollections scope="ELECTRONIC" /></Guard>}
          />
          <Route
            path="/reports/summary-of-collections"
            element={<Guard module="reports"><SummaryOfCollections /></Guard>}
          />
          <Route
            path="/reports/rcd-transmittal"
            element={<Guard module="reports"><RcdTransmittal /></Guard>}
          />
          <Route
            path="/reports/cancelled-checks"
            element={<Guard module="reports"><CancelledChecks /></Guard>}
          />
          <Route
            path="/reports/cash-in-local-treasury"
            element={<Guard module="reports"><CashInLocalTreasury /></Guard>}
          />

          {/* Master data */}
          <Route path="/master-data" element={<Navigate to="/master-data/accounts" replace />} />
          {/* Before the :entity route, or "accounts/upload" would be read as
              an entity called "accounts" with a stray path segment. */}
          <Route
            path="/master-data/accounts/upload"
            element={<Guard module="masterData" action="create"><ChartUpload /></Guard>}
          />
          {/* The programmes moved to a tab beside the appropriations, where
              they are kept per year. The old Master Data address still
              arrives - a bookmark should not become a dead end. It is listed
              BEFORE the catch-all below, which would otherwise swallow it. */}
          <Route
            path="/master-data/ppa"
            element={<Navigate to="/budget/appropriations/programmes" replace />}
          />
          <Route path="/master-data/:entity" element={<Guard module="masterData"><MasterData /></Guard>} />

          {/* Documents, administration, audit */}
          <Route path="/documents" element={<Guard module="documents"><Documents /></Guard>} />

          {/* Your own account. Behind no module guard on purpose: changing
              your own password is not a permission anybody grants, and a user
              whose roles have not been granted yet still owns their account. */}
          <Route path="/account/password" element={<ChangePassword />} />
          <Route path="/administration" element={<Navigate to="/administration/users" replace />} />
          <Route path="/administration/users" element={<Guard module="administration"><Users /></Guard>} />
          <Route path="/administration/periods" element={<Guard module="administration"><Periods /></Guard>} />
          <Route path="/administration/numbering" element={<Guard module="administration"><Numbering /></Guard>} />
          <Route path="/administration/settings" element={<Guard module="administration"><Settings /></Guard>} />
          <Route path="/audit-trail" element={<Guard module="auditTrail"><AuditTrail /></Guard>} />
          <Route path="/notifications" element={<Notifications />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

function Guard({
  module,
  action = 'view',
  children,
}: {
  module: Module;
  action?: Action;
  children: ReactNode;
}) {
  const { can, roles } = useAuth();
  const location = useLocation();

  if (can(module, action)) return <>{children}</>;

  return (
    <EmptyState
      title="You do not have access to this screen"
      message={
        `Your role${roles.length > 1 ? 's' : ''} (${roles.join(', ') || 'none'}) ` +
        `${roles.length > 1 ? 'do' : 'does'} not include permission to ${action} in the ${module} module. ` +
        'If you need it for your work, ask the Municipal Accounting Office to adjust your access.'
      }
      action={
        <Button onClick={() => window.history.back()} variant="secondary">
          Go back
        </Button>
      }
      icon={
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
          />
        </svg>
      }
      key={location.pathname}
    />
  );
}

function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      message="That address does not correspond to a screen in CFMS."
      action={
        <Button variant="primary" onClick={() => (window.location.href = '/')}>
          Go to the dashboard
        </Button>
      }
    />
  );
}

/**
 * Carries an old /accounting/others/{id} address to its new home.
 *
 * The screen is called General Transactions since patch 78. The address was
 * written into notifications and into every audit-trail row for an entry, and
 * those are records - they are not rewritten because a screen was renamed.
 */
function RedirectToGeneralTransaction() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/accounting/general-transactions/${id ?? ''}`} replace />;
}

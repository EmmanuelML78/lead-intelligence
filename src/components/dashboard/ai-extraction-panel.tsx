import {
  MISSING_AI_EXTRACTION_COPY,
  formatCop,
  objectionLabel,
  paymentMethodLabel,
  purchaseIntentLabel
} from "../../lib/dashboard/present";
import type { AiExtractionView } from "../../lib/dashboard/present";

function Evidence({ items }: { items: string[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="evidence">
      {items.slice(0, 2).map((item) => (
        <li key={item}>“{item}”</li>
      ))}
    </ul>
  );
}

export function AiExtractionPanel({ extraction }: { extraction: AiExtractionView | null }) {
  if (!extraction) {
    return (
      <section className="panel">
        <div className="eyebrow">Conversation intelligence</div>
        <h2>AI extraction</h2>
        <p className="muted">{MISSING_AI_EXTRACTION_COPY}</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="eyebrow">Conversation intelligence</div>
      <h2>AI extraction</h2>
      <dl className="facts">
        <div>
          <dt>Motorcycle interest</dt>
          <dd>{extraction.motorcycleInterest ?? "—"}</dd>
          <Evidence items={extraction.evidence.motorcycleInterest} />
        </div>
        <div>
          <dt>Budget</dt>
          <dd>{formatCop(extraction.budget)}</dd>
          <Evidence items={extraction.evidence.budget} />
        </div>
        <div>
          <dt>Down payment</dt>
          <dd>{formatCop(extraction.downPayment)}</dd>
          <Evidence items={extraction.evidence.downPayment} />
        </div>
        <div>
          <dt>Payment method</dt>
          <dd>{paymentMethodLabel(extraction.paymentMethod)}</dd>
          <Evidence items={extraction.evidence.paymentMethod} />
        </div>
        <div>
          <dt>Purchase intent</dt>
          <dd>{purchaseIntentLabel(extraction.purchaseIntent)}</dd>
          <Evidence items={extraction.evidence.purchaseIntent} />
        </div>
        <div>
          <dt>Main objection</dt>
          <dd>{objectionLabel(extraction.mainObjection)}</dd>
          <Evidence items={extraction.evidence.mainObjection} />
        </div>
        <div>
          <dt>Appointment requested</dt>
          <dd>{extraction.requestedAppointment ? "Yes" : "No"}</dd>
          <Evidence items={extraction.evidence.requestedAppointment} />
        </div>
        <div>
          <dt>Quote requested</dt>
          <dd>{extraction.requestedQuote ? "Yes" : "No"}</dd>
          <Evidence items={extraction.evidence.requestedQuote} />
        </div>
      </dl>
    </section>
  );
}

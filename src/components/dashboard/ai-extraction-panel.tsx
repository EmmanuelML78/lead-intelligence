import {
  MISSING_AI_EXTRACTION_COPY,
  formatCop,
  objectionLabel,
  paymentMethodLabel,
  purchaseIntentLabel,
  yesNo
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
        <div className="eyebrow">Inteligencia de la conversación</div>
        <h2>Extracción de IA</h2>
        <p className="muted">{MISSING_AI_EXTRACTION_COPY}</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="eyebrow">Inteligencia de la conversación</div>
      <h2>Extracción de IA</h2>
      <p className="muted">
        {extraction.evidenceStatus === "CHECKED"
          ? "Citas contrastadas con el texto mostrado; no verifican la interpretación de la IA."
          : "Evidencia histórica no verificada contra este transcript; las citas se ocultan."}
        {extraction.droppedEvidenceCount > 0 && ` Se omitieron ${extraction.droppedEvidenceCount} citas que no aparecen en el texto.`}
      </p>
      <dl className="facts">
        <div>
          <dt>Interés de motocicleta</dt>
          <dd>{extraction.motorcycleInterest ?? "—"}</dd>
          <Evidence items={extraction.evidence.motorcycleInterest} />
        </div>
        <div>
          <dt>Presupuesto</dt>
          <dd>{formatCop(extraction.budget)}</dd>
          <Evidence items={extraction.evidence.budget} />
        </div>
        <div>
          <dt>Cuota inicial</dt>
          <dd>{formatCop(extraction.downPayment)}</dd>
          <Evidence items={extraction.evidence.downPayment} />
        </div>
        <div>
          <dt>Método de pago</dt>
          <dd>{paymentMethodLabel(extraction.paymentMethod)}</dd>
          <Evidence items={extraction.evidence.paymentMethod} />
        </div>
        <div>
          <dt>Intención de compra</dt>
          <dd>{purchaseIntentLabel(extraction.purchaseIntent)}</dd>
          <Evidence items={extraction.evidence.purchaseIntent} />
        </div>
        <div>
          <dt>Objeción principal</dt>
          <dd>{objectionLabel(extraction.mainObjection)}</dd>
          <Evidence items={extraction.evidence.mainObjection} />
        </div>
        <div>
          <dt>Pidió cita</dt>
          <dd>{yesNo(extraction.requestedAppointment)}</dd>
          <Evidence items={extraction.evidence.requestedAppointment} />
        </div>
        <div>
          <dt>Pidió cotización</dt>
          <dd>{yesNo(extraction.requestedQuote)}</dd>
          <Evidence items={extraction.evidence.requestedQuote} />
        </div>
      </dl>
    </section>
  );
}

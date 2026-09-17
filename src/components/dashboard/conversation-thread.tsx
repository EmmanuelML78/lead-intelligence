import {
  transcriptRoleLabel,
  type ConversationMessageView
} from "../../lib/dashboard/present";

export function ConversationThread({ messages }: { messages: ConversationMessageView[] }) {
  return (
    <section className="panel">
      <div className="eyebrow">WhatsApp</div>
      <h2>Conversación</h2>
      {messages.length === 0 ? (
        <p className="muted">No hay conversación persistida para este lead.</p>
      ) : (
        <div className="thread">
          {messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role.toLowerCase()}`}>
              <div className="meta">
                {transcriptRoleLabel(message.role)}
                {message.sentTime ? ` · ${message.sentTime}` : ""}
              </div>
              {message.text}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

use super::{CheckoutInput, CheckoutSession, ProcessorContext, ProcessorError, ProcessorKind};

pub(crate) async fn create_session(
    _context: ProcessorContext<'_>,
    input: CheckoutInput<'_>,
) -> Result<CheckoutSession, ProcessorError> {
    // Mark currently unused fields to avoid warnings until paid flows land.
    let _ = input.org_id;
    let _ = input.project_id;
    let _ = input.cancel_url;

    // For free plans we simply bounce the user back to the provided success URL.
    if input.plan.monthly_price_cents > 0 {
        return Err(ProcessorError::NotImplemented(
            "Paid plans require a real payment processor integration.",
        ));
    }

    Ok(CheckoutSession {
        processor: ProcessorKind::Dev,
        checkout_url: input.success_url.to_string(),
        reference: None,
        expires_at: None,
    })
}

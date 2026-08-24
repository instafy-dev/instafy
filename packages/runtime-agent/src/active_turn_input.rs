use std::sync::Arc;

use tokio::sync::{Mutex, mpsc, oneshot, watch};
use uuid::Uuid;

/// A controller command waiting to be submitted to the currently active model
/// turn. The acknowledgement is completed only after Codex accepts or rejects
/// the same-turn input; receiving the command from HTTP is not enough.
#[derive(Debug)]
pub struct ActiveTurnInputCommand {
    pub command_id: Uuid,
    pub content: String,
    pub expected_turn_id: String,
    acknowledgement: oneshot::Sender<ActiveTurnInputOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActiveTurnInputOutcome {
    Applied { codex_turn_id: String },
    Rejected { error_message: String },
}

#[derive(Clone, Debug)]
pub struct ActiveTurnInputSender {
    sender: mpsc::Sender<ActiveTurnInputCommand>,
    readiness: watch::Receiver<Option<String>>,
    cancellation: watch::Receiver<bool>,
}

#[derive(Clone, Debug)]
pub struct ActiveTurnInputReceiver {
    receiver: Arc<Mutex<mpsc::Receiver<ActiveTurnInputCommand>>>,
    readiness: watch::Sender<Option<String>>,
}

#[derive(Clone, Debug)]
pub struct ActiveTurnInputCancellation {
    cancellation: watch::Sender<bool>,
}

pub fn active_turn_input_channel(
    capacity: usize,
) -> (
    ActiveTurnInputSender,
    ActiveTurnInputReceiver,
    ActiveTurnInputCancellation,
) {
    let (sender, receiver) = mpsc::channel(capacity.max(1));
    let (readiness, readiness_receiver) = watch::channel(None);
    let (cancellation, cancellation_receiver) = watch::channel(false);
    (
        ActiveTurnInputSender {
            sender,
            readiness: readiness_receiver,
            cancellation: cancellation_receiver,
        },
        ActiveTurnInputReceiver {
            receiver: Arc::new(Mutex::new(receiver)),
            readiness,
        },
        ActiveTurnInputCancellation { cancellation },
    )
}

impl ActiveTurnInputSender {
    pub fn is_ready(&self) -> bool {
        self.readiness.borrow().is_some()
    }

    pub fn active_turn_id(&self) -> Option<String> {
        self.readiness.borrow().clone()
    }

    pub async fn readiness_changed(&mut self) -> bool {
        self.readiness.changed().await.is_ok()
    }

    pub async fn submit(
        &self,
        command_id: Uuid,
        content: String,
        expected_turn_id: String,
    ) -> ActiveTurnInputOutcome {
        if self.active_turn_id().as_deref() != Some(expected_turn_id.as_str())
            || *self.cancellation.borrow()
        {
            return ActiveTurnInputOutcome::Rejected {
                error_message: "active Codex turn changed before input submission".to_string(),
            };
        }
        let (acknowledgement, mut result) = oneshot::channel();
        let command = ActiveTurnInputCommand {
            command_id,
            content,
            expected_turn_id: expected_turn_id.clone(),
            acknowledgement,
        };
        if self.sender.send(command).await.is_err() {
            return ActiveTurnInputOutcome::Rejected {
                error_message: "active Codex turn completed before input submission".to_string(),
            };
        }
        let mut cancellation = self.cancellation.clone();
        let mut readiness = self.readiness.clone();
        loop {
            tokio::select! {
                biased;
                result = &mut result => return result.unwrap_or_else(|_| ActiveTurnInputOutcome::Rejected {
                    error_message: "active Codex turn completed before input acknowledgement".to_string(),
                }),
                _ = cancellation.changed() => return ActiveTurnInputOutcome::Rejected {
                    error_message: "active Codex turn ended before input acknowledgement".to_string(),
                },
                changed = readiness.changed() => {
                    if changed.is_err()
                        || readiness.borrow().as_deref() != Some(expected_turn_id.as_str())
                    {
                        return ActiveTurnInputOutcome::Rejected {
                            error_message: "active Codex turn changed before input acknowledgement".to_string(),
                        };
                    }
                },
            }
        }
    }
}

impl ActiveTurnInputCancellation {
    pub fn cancel(&self) {
        self.cancellation.send_replace(true);
    }
}

impl ActiveTurnInputReceiver {
    pub async fn recv(&self) -> Option<ActiveTurnInputCommand> {
        self.receiver.lock().await.recv().await
    }

    pub fn set_ready(&self, turn_id: Option<String>) {
        self.readiness.send_replace(turn_id);
    }
}

impl ActiveTurnInputCommand {
    pub fn acknowledge(self, outcome: ActiveTurnInputOutcome) {
        let _ = self.acknowledgement.send(outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sender_waits_for_codex_submission_acknowledgement() {
        let (sender, receiver, _cancellation) = active_turn_input_channel(1);
        receiver.set_ready(Some("turn-1".to_string()));
        let command_id = Uuid::new_v4();
        let send = tokio::spawn(async move {
            sender
                .submit(
                    command_id,
                    "steer this turn".to_string(),
                    "turn-1".to_string(),
                )
                .await
        });

        let command = receiver.recv().await.expect("command");
        assert_eq!(command.command_id, command_id);
        assert_eq!(command.content, "steer this turn");
        assert_eq!(command.expected_turn_id, "turn-1");
        command.acknowledge(ActiveTurnInputOutcome::Applied {
            codex_turn_id: "turn-1".to_string(),
        });

        assert_eq!(
            send.await.expect("sender task"),
            ActiveTurnInputOutcome::Applied {
                codex_turn_id: "turn-1".to_string()
            }
        );
    }

    #[tokio::test]
    async fn dropped_active_turn_rejects_a_waiting_command() {
        let (sender, receiver, _cancellation) = active_turn_input_channel(1);
        receiver.set_ready(Some("turn-1".to_string()));
        let send = tokio::spawn(async move {
            sender
                .submit(Uuid::new_v4(), "too late".to_string(), "turn-1".to_string())
                .await
        });
        let _command = receiver.recv().await.expect("command");
        drop(_command);
        drop(receiver);

        assert!(matches!(
            send.await.expect("sender task"),
            ActiveTurnInputOutcome::Rejected { .. }
        ));
    }

    #[tokio::test]
    async fn workflow_or_direct_path_never_accepts_without_provider_turn_readiness() {
        let (sender, receiver, _cancellation) = active_turn_input_channel(1);
        let outcome = sender
            .submit(
                Uuid::new_v4(),
                "must not strand".to_string(),
                "turn-1".to_string(),
            )
            .await;
        assert!(matches!(outcome, ActiveTurnInputOutcome::Rejected { .. }));
        // No command was placed into the live receiver when readiness was
        // false, so an execution path that never owns Codex cannot strand a
        // claimed controller command waiting on an unconsumed channel.
        receiver.set_ready(Some("turn-1".to_string()));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), receiver.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancellation_fence_resolves_submit_even_while_receiver_clone_is_alive() {
        let (sender, receiver, cancellation) = active_turn_input_channel(1);
        receiver.set_ready(Some("turn-1".to_string()));
        let send = tokio::spawn(async move {
            sender
                .submit(
                    Uuid::new_v4(),
                    "raced with turn end".to_string(),
                    "turn-1".to_string(),
                )
                .await
        });
        let _queued_command = receiver.recv().await.expect("queued command");

        cancellation.cancel();
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(100), send)
            .await
            .expect("submit must not hang")
            .expect("sender task");
        assert!(matches!(outcome, ActiveTurnInputOutcome::Rejected { .. }));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn applied_ack_wins_when_ack_and_turn_end_are_both_ready() {
        let (sender, receiver, cancellation) = active_turn_input_channel(1);
        receiver.set_ready(Some("turn-1".to_string()));
        let send = tokio::spawn(async move {
            sender
                .submit(
                    Uuid::new_v4(),
                    "accepted before turn end".to_string(),
                    "turn-1".to_string(),
                )
                .await
        });
        let command = receiver.recv().await.expect("queued command");
        command.acknowledge(ActiveTurnInputOutcome::Applied {
            codex_turn_id: "turn-1".to_string(),
        });
        cancellation.cancel();

        assert_eq!(
            send.await.expect("sender task"),
            ActiveTurnInputOutcome::Applied {
                codex_turn_id: "turn-1".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn rollover_never_queues_a_command_for_a_different_turn() {
        let (sender, receiver, _cancellation) = active_turn_input_channel(1);
        receiver.set_ready(Some("turn-b".to_string()));
        let outcome = sender
            .submit(
                Uuid::new_v4(),
                "belongs to turn a".to_string(),
                "turn-a".to_string(),
            )
            .await;
        assert!(matches!(outcome, ActiveTurnInputOutcome::Rejected { .. }));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), receiver.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rollover_resolves_a_command_waiting_for_the_old_turn() {
        let (sender, receiver, _cancellation) = active_turn_input_channel(1);
        receiver.set_ready(Some("turn-a".to_string()));
        let send = tokio::spawn(async move {
            sender
                .submit(
                    Uuid::new_v4(),
                    "belongs to turn a".to_string(),
                    "turn-a".to_string(),
                )
                .await
        });
        let _queued_command = receiver.recv().await.expect("queued command");
        receiver.set_ready(Some("turn-b".to_string()));

        let outcome = tokio::time::timeout(std::time::Duration::from_millis(100), send)
            .await
            .expect("old turn submit must resolve")
            .expect("sender task");
        assert!(matches!(outcome, ActiveTurnInputOutcome::Rejected { .. }));
    }
}

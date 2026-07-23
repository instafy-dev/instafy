import { Plus } from "iconoir-react";
import { IconButton } from "../../../components/Button";

type SettingsAddButtonProps = {
  onPress: () => void;
  isDisabled?: boolean;
  "data-testid"?: string;
  ariaLabel: string;
  title?: string;
};

export function SettingsAddButton({
  onPress,
  isDisabled,
  "data-testid": dataTestId,
  ariaLabel,
  title,
}: SettingsAddButtonProps) {
  return (
    <IconButton
      onPress={onPress}
      isDisabled={isDisabled}
      variant="ghost"
      size="sm"
      radius="full"
      data-testid={dataTestId}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
    </IconButton>
  );
}

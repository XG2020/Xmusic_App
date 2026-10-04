import './ToggleSwitch.css';

interface ToggleSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
}

/** Match the mobile settings switch while retaining native button keyboard behavior. */
export function ToggleSwitch({checked, onCheckedChange, label, disabled = false, id, describedBy}: ToggleSwitchProps) {
  return <button type="button" id={id} className="toggle-switch" role="switch" aria-checked={checked}
    aria-label={label} aria-describedby={describedBy} disabled={disabled} onClick={() => onCheckedChange(!checked)}>
    <span className="toggle-switch-thumb" aria-hidden="true"/>
  </button>;
}

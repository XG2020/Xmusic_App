import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Check, ChevronDown} from 'lucide-react';
import './SettingsSelect.css';

export interface SettingsSelectOption {value: string; label: string}

export function SettingsSelect({label, id, value, options, onChange, disabled = false}: {
  label: string;
  id?: string;
  value: string;
  options: readonly SettingsSelectOption[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const listId = `${generatedId}-listbox`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const positionedAnchor = useRef<DOMRect | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [location, setLocation] = useState<{left: number; top: number; width: number; maxHeight: number} | null>(null);
  const selectedIndex = options.findIndex(option => option.value === value);
  const expanded = open && !disabled && options.length > 0;
  const optionKey = JSON.stringify(options);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const openPicker = (index = Math.max(0, selectedIndex)) => {
    if (disabled || !options.length) return;
    setActive(index); setLocation(null); setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  useLayoutEffect(() => {
    if (!expanded || !trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    positionedAnchor.current = anchor;
    const width = Math.min(Math.max(anchor.width, 190), Math.max(1, window.innerWidth - 16));
    // Measure after constraining width so wrapped labels contribute their full
    // height before deciding whether the list fits above or below the control.
    popup.current.style.width = `${width}px`;
    const borderHeight = popup.current.offsetHeight - popup.current.clientHeight;
    const naturalHeight = Math.min((popup.current.scrollHeight || options.length * 38 + 12) + borderHeight, 280);
    const below = window.innerHeight - anchor.bottom - 14;
    const above = anchor.top - 14;
    const opensAbove = below < naturalHeight && above > below;
    const maxHeight = Math.max(1, Math.min(280, opensAbove ? above : below));
    const height = Math.min(naturalHeight, maxHeight);
    setLocation({width, maxHeight, left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(opensAbove ? anchor.top - height - 6 : anchor.bottom + 6, window.innerHeight - height - 8))});
    setActive(index => Math.max(0, Math.min(index, options.length - 1)));
  }, [expanded, optionKey]);
  useEffect(() => {if (disabled || !options.length) setOpen(false);}, [disabled, options.length]);
  useLayoutEffect(() => {
    const list = popup.current;
    const option = document.getElementById(optionId(active));
    if (!expanded || !location || !list || !option) return;
    // scrollIntoView can move the document before the portal has its final
    // position. Keep keyboard navigation strictly inside the positioned list.
    const innerTop = list.getBoundingClientRect().top + list.clientTop;
    const row = option.getBoundingClientRect();
    if (row.top < innerTop) list.scrollTop += row.top - innerTop;
    else if (row.bottom > innerTop + list.clientHeight) list.scrollTop += row.bottom - innerTop - list.clientHeight;
  }, [expanded, active, location]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      const previous = positionedAnchor.current;
      const current = trigger.current?.getBoundingClientRect();
      // Opening by click/focus may follow an ancestor scroll whose event is
      // delivered later. Its final position was already measured above; only
      // subsequent movement of the anchor makes this popup stale.
      if (!previous || !current || (['left', 'top', 'right', 'bottom'] as const).some(key => Math.abs(current[key] - previous[key]) > .5)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [expanded]);

  return <>
    <button ref={trigger} id={controlId} type="button" className="settings-select" role="combobox" aria-label={label}
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded ? optionId(active) : undefined} disabled={disabled || !options.length}
      onClick={() => {if (expanded) setOpen(false); else openPicker();}}
      onBlur={event => {if (!(event.relatedTarget instanceof Node) || !popup.current?.contains(event.relatedTarget)) setOpen(false);}}
      onKeyDown={event => {
        if (disabled || !options.length) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (!expanded) openPicker(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, selectedIndex));
          else setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation();
          if (expanded) choose(active); else openPicker();
        } else if (event.key === 'Escape' && expanded) {
          event.preventDefault(); event.stopPropagation(); setOpen(false);
        } else if (event.key === 'Tab') setOpen(false);
      }}>
      <span>{options[selectedIndex]?.label ?? value}</span><ChevronDown size={15} aria-hidden="true"/>
    </button>
    {expanded && createPortal(<div ref={popup} id={listId} className="settings-select-listbox" role="listbox" aria-label={label}
      style={{left: location?.left ?? 0, top: location?.top ?? 0, width: location?.width, maxHeight: location?.maxHeight ?? 280, visibility: location ? 'visible' : 'hidden'}}
      onMouseDown={event => {event.preventDefault(); event.stopPropagation();}}
      onClick={event => {event.preventDefault(); event.stopPropagation();}}>
      {options.map((option, index) => <div id={optionId(index)} key={option.value} role="option" aria-selected={option.value === value}
        className={`settings-select-option ${active === index ? 'highlighted' : ''}`} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span>{option.label}</span><Check size={15} aria-hidden="true" className={option.value === value ? 'selected-check' : 'unselected-check'}/>
      </div>)}
    </div>, document.body)}
  </>;
}

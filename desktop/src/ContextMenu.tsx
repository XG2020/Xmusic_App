import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import './ContextMenu.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  danger?: boolean;
}

export function ContextMenu({items, position, onClose, ariaLabel = '操作菜单'}: {
  items: ContextMenuItem[];
  position: {x: number; y: number};
  onClose(): void;
  ariaLabel?: string;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const previousFocus = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const restoreFocus = useRef(true);
  const [location, setLocation] = useState<{x: number; y: number} | null>(null);
  const itemKey = items.map(item => `${item.id}:${!!item.disabled}`).join('|');
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    if (document.activeElement instanceof HTMLElement && !node.contains(document.activeElement)) previousFocus.current = document.activeElement;
    restoreFocus.current = true;
    const rect = node.getBoundingClientRect();
    setLocation({x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8))});
    (node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? node).focus({preventScroll: true});
  }, [position.x, position.y, itemKey]);
  useEffect(() => {
    // Capture the trigger before the layout effect moves focus into the menu.
    const node = menu.current;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !node?.contains(event.target)) {
        restoreFocus.current = false;
        close.current();
      }
    };
    const dismiss = () => close.current();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      const trigger = previousFocus.current;
      if (restoreFocus.current && trigger?.isConnected && !trigger.closest('[inert]') && (document.activeElement === document.body || node?.contains(document.activeElement))) trigger.focus({preventScroll: true});
    };
  }, []);
  return createPortal(<div ref={menu} className="context-menu" role="menu" aria-label={ariaLabel} tabIndex={-1}
    style={{left: location?.x ?? position.x, top: location?.y ?? position.y, visibility: location ? 'visible' : 'hidden'}}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); close.current();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); options[index]?.click();
      }
    }}>
    {items.map(item => <button type="button" role="menuitem" tabIndex={-1} key={item.id} disabled={item.disabled}
      className={item.danger ? 'context-menu-item danger' : 'context-menu-item'} onClick={() => {close.current(); item.onSelect();}}>
      {item.icon && <span className="context-menu-icon" aria-hidden="true">{item.icon}</span>}<span>{item.label}</span>
    </button>)}
  </div>, document.body);
}

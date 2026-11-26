import * as React from 'react';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as ContextPrimitive from '@radix-ui/react-context-menu';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const content =
  'z-50 min-w-48 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95';
const item =
  "relative flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:[&_svg]:text-destructive";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentProps<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content sideOffset={sideOffset} className={cn(content, className)} {...props} />
    </DropdownPrimitive.Portal>
  );
}
export function DropdownMenuItem({ className, variant, shortcut, children, ...props }: React.ComponentProps<typeof DropdownPrimitive.Item> & { variant?: 'destructive'; shortcut?: string }) {
  return (
    <DropdownPrimitive.Item data-variant={variant} className={cn(item, className)} {...props}>
      {children}
      {shortcut && <span className="ml-auto pl-4 text-[11px] text-muted-foreground">{shortcut}</span>}
    </DropdownPrimitive.Item>
  );
}
export function DropdownMenuSeparator() {
  return <DropdownPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownPrimitive.Label>) {
  return <DropdownPrimitive.Label className={cn('px-2 py-1 text-[11px] font-medium text-muted-foreground', className)} {...props} />;
}

export const ContextMenu = ContextPrimitive.Root;
export const ContextMenuTrigger = ContextPrimitive.Trigger;
export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextPrimitive.Content>) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.Content className={cn(content, className)} {...props} />
    </ContextPrimitive.Portal>
  );
}
export function ContextMenuItem({ className, variant, shortcut, children, ...props }: React.ComponentProps<typeof ContextPrimitive.Item> & { variant?: 'destructive'; shortcut?: string }) {
  return (
    <ContextPrimitive.Item data-variant={variant} className={cn(item, className)} {...props}>
      {children}
      {shortcut && <span className="ml-auto pl-4 text-[11px] text-muted-foreground">{shortcut}</span>}
    </ContextPrimitive.Item>
  );
}
export function ContextMenuSeparator() {
  return <ContextPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}
export const ContextMenuSub = ContextPrimitive.Sub;
export function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof ContextPrimitive.SubTrigger>) {
  return (
    <ContextPrimitive.SubTrigger className={cn(item, 'data-[state=open]:bg-accent', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </ContextPrimitive.SubTrigger>
  );
}
export function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof ContextPrimitive.SubContent>) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.SubContent className={cn(content, className)} {...props} />
    </ContextPrimitive.Portal>
  );
}

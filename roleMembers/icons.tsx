/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Permission status icons, copied from src/plugins/permissionsViewer/components/icons.tsx

export function PermissionDeniedIcon() {
    return (
        <svg height="24" width="24" viewBox="0 0 24 24" aria-hidden="true">
            <title>Denied</title>
            <path fill="var(--status-danger)" d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
        </svg>
    );
}

export function PermissionAllowedIcon() {
    return (
        <svg height="24" width="24" viewBox="0 0 24 24" aria-hidden="true">
            <title>Allowed</title>
            <path fill="var(--status-positive)" d="M8.99991 16.17L4.82991 12L3.40991 13.41L8.99991 19L20.9999 7.00003L19.5899 5.59003L8.99991 16.17Z" />
        </svg>
    );
}

// Menu item icon (people), adapted from src/plugins/betterRoleContext
export function RoleMembersIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11.53 11A9.53 9.53 0 0 0 2 20.53c0 .81.66 1.47 1.47 1.47h.22c.24 0 .44-.17.5-.4.29-1.12.84-2.17 1.32-2.91.14-.21.43-.1.4.15l-.26 2.61c-.02.3.2.55.5.55h11.7a.5.5 0 0 0 .5-.55l-.27-2.6c-.02-.26.27-.37.41-.16.48.74 1.03 1.8 1.32 2.9.06.24.26.41.5.41h.22c.81 0 1.47-.66 1.47-1.47A9.53 9.53 0 0 0 12.47 11h-.94Z" />
        </svg>
    );
}

// Custom permission leading icons (18x18, inherit color unless overridden)

function PermIcon({ path, color, label }: { path: string; color?: string; label: string; }) {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" className="vc-rolemembers-perm-glyph" aria-label={label}>
            <title>{label}</title>
            <path fill={color ?? "currentColor"} d={path} />
        </svg>
    );
}

const GAVEL = "M1 21h12v2H1v-2zM5.24 8.07l2.83-2.83L22.21 19.4l-2.83 2.83L5.24 8.07zM12.31 1l5.66 5.66-2.83 2.83-5.66-5.66L12.31 1zM3.83 9.48l5.66 5.66-2.83 2.83-5.66-5.66 2.83-2.83z";

export const BanHammerIcon = () => <PermIcon label="Ban" color="var(--status-danger)" path={GAVEL} />;
export const KickHammerIcon = () => <PermIcon label="Kick" color="var(--header-primary)" path={GAVEL} />;

export const ShieldIcon = () => <PermIcon label="Administrator" color="var(--status-danger)" path="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />;

export const GearIcon = () => <PermIcon label="Manage Server" path="M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z" />;

export const TagIcon = () => <PermIcon label="Manage Roles" path="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16zM16 17H5V7h11l3.55 5L16 17z" />;

export const HashIcon = () => <PermIcon label="Manage Channels" path="M20 10V8h-4V4h-2v4h-4V4H8v4H4v2h4v4H4v2h4v4h2v-4h4v4h2v-4h4v-2h-4v-4h4zm-6 4h-4v-4h4v4z" />;

export const LinkIcon = () => <PermIcon label="Manage Webhooks" path="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />;

export const ClockIcon = () => <PermIcon label="Timeout Members" path="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z" />;

export const PencilIcon = () => <PermIcon label="Manage Nicknames" path="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />;

export const TrashIcon = () => <PermIcon label="Manage Messages" path="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />;

export const ScrollIcon = () => <PermIcon label="View Audit Log" path="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />;

export const MentionIcon = () => <PermIcon label="Mention Everyone" path="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.73 0 3.41-.44 4.9-1.27l-.85-1.51A8.04 8.04 0 0 1 12 20c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8v1.07c0 .85-.69 1.43-1.25 1.43s-1.25-.58-1.25-1.43V12c0-2.48-2.02-4.5-4.5-4.5S7 9.52 7 12s2.02 4.5 4.5 4.5c1.24 0 2.36-.51 3.18-1.32.56.81 1.55 1.32 2.57 1.32C20.8 16.5 22 14.62 22 12.07V12c0-5.52-4.48-10-10-10zm0 12.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />;

export const PaperclipIcon = () => <PermIcon label="Attach Files" path="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />;

// Search bar icons

export function SearchIcon({ className }: { className?: string; }) {
    return (
        <svg className={className} width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M21.71 20.29 18 16.61A9 9 0 1 0 16.61 18l3.68 3.71a1 1 0 0 0 1.42 0 1 1 0 0 0 0-1.42ZM11 18a7 7 0 1 1 7-7 7 7 0 0 1-7 7Z" />
        </svg>
    );
}

export function ClearIcon({ className }: { className?: string; }) {
    return (
        <svg className={className} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M18.4 4 12 10.4 5.6 4 4 5.6 10.4 12 4 18.4 5.6 20 12 13.6 18.4 20 20 18.4 13.6 12 20 5.6 18.4 4Z" />
        </svg>
    );
}

// Opens a member's profile (used as a per-row button)
export function ProfileIcon({ className }: { className?: string; }) {
    return (
        <svg className={className} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.69-8 6 0 1.1.9 2 2 2h12a2 2 0 0 0 2-2c0-3.31-3.58-6-8-6Z" />
        </svg>
    );
}

// Portifact design system: components and patterns. Tokens are imported as CSS from
// `@portifact/ui/theme.css`.
export { Avatar, type AvatarProps, initialOf, initials } from "./components/avatar.tsx";
export { Badge, type BadgeProps } from "./components/badge.tsx";
export { BarChart, type BarChartDatum, type BarChartProps } from "./components/bar-chart.tsx";
export { Button, type ButtonProps, buttonClasses } from "./components/button.tsx";
export { Callout, type CalloutProps } from "./components/callout.tsx";
export { ConfirmDialog, type ConfirmDialogProps } from "./components/confirm-dialog.tsx";
export { CopyField, type CopyFieldProps } from "./components/copy-field.tsx";
export { type DetailItem, DetailList, type DetailListProps } from "./components/detail-list.tsx";
export { Disclosure, type DisclosureProps } from "./components/disclosure.tsx";
export { Drawer, type DrawerProps } from "./components/drawer.tsx";
export {
  type DroppedFile,
  type DroppedItems,
  DropZone,
  type DropZoneProps,
  readDrop,
} from "./components/drop-zone.tsx";
export { EmptyState, type EmptyStateProps } from "./components/empty-state.tsx";
export {
  Checkbox,
  type CheckboxProps,
  RadioGroup,
  type RadioGroupProps,
  type RadioOption,
  SearchField,
  type SearchFieldProps,
  TextArea,
  type TextAreaProps,
  TextInput,
  type TextInputProps,
} from "./components/fields.tsx";
export { canPickFolders, FilePicker, type FilePickerProps } from "./components/file-picker.tsx";
export {
  IconButton,
  type IconButtonProps,
  IconLink,
  type IconLinkProps,
  iconButtonClasses,
} from "./components/icon-button.tsx";
export {
  type Language,
  LanguageSwitcher,
  type LanguageSwitcherProps,
} from "./components/language-switcher.tsx";
export { LiveRegion } from "./components/live-region.tsx";
export { LoadingState, type LoadingStateProps } from "./components/loading-state.tsx";
export { Menu, type MenuItem, type MenuProps } from "./components/menu.tsx";
export { Meter, type MeterProps } from "./components/meter.tsx";
export { Panel, type PanelProps } from "./components/panel.tsx";
export { PreviewFrame, type PreviewFrameProps } from "./components/preview-frame.tsx";
export { ProgressBar, type ProgressBarProps } from "./components/progress.tsx";
export { ResizeHandle, type ResizeHandleProps } from "./components/resize-handle.tsx";
export {
  placeListbox,
  Select,
  type SelectOption,
  type SelectProps,
  typeaheadMatch,
} from "./components/select.tsx";
export { Sheet, type SheetProps } from "./components/sheet.tsx";
export { type Step, Steps, type StepsProps } from "./components/steps.tsx";
export {
  rowControlClasses,
  rowLinkClasses,
  Table,
  TableBody,
  TableCell,
  type TableCellProps,
  TableHead,
  TableHeaderCell,
  type TableProps,
  TableRow,
  type TableRowProps,
} from "./components/table.tsx";
export {
  ThemedImage,
  type ThemedImageProps,
  ThemeSwitcher,
  type ThemeSwitcherProps,
  themeSwitcherClasses,
  useThemePreference,
} from "./components/theme-switcher.tsx";
export { Toast, type ToastProps } from "./components/toast.tsx";
export { Tooltip, type TooltipProps } from "./components/tooltip.tsx";
export { useMediaQuery, WIDE_QUERY } from "./hooks/use-media-query.ts";
export {
  AppShell,
  type AppShellLabels,
  type AppShellNavItem,
  type AppShellProps,
  backLinkClasses,
  navLinkClasses,
  PageHeader,
  type PageHeaderProps,
  SIDEBAR_WIDTH,
  SidebarAccount,
  type SidebarAccountProps,
  useSidebarCollapsed,
} from "./patterns/app-shell.tsx";
export {
  Floating,
  FloatingPanel,
  type FloatingPanelProps,
  type FloatingProps,
  FrameOverlay,
  type FrameOverlayProps,
  keyboardInset,
  type OverlayPoint,
  type OverlaySize,
  type VisualViewportBox,
} from "./patterns/frame-overlay.tsx";
export {
  GUIDE_QUERY,
  PageSection,
  type PageSectionLink,
  type PageSectionProps,
  SectionedPage,
  type SectionedPageProps,
} from "./patterns/section-nav.tsx";
export { ViewerShell, type ViewerShellProps } from "./patterns/viewer-shell.tsx";
export {
  applyTheme,
  darkSourceMedia,
  isThemePreference,
  setThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from "./theme/theme.ts";

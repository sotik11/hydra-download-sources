# Shows a Windows toast (lands in the Action Center) without any external module,
# via the built-in WinRT ToastNotificationManager under Windows PowerShell's own
# registered AppUserModelID. Called by refresh_local.sh on start / finish.
#
# Must run under Windows PowerShell 5.1 (powershell.exe) — pwsh 7 has no WinRT
# projection by default. Best-effort: a failed toast must never fail the refresh.
param(
  [string]$Title = "Hydra localization refresh",
  [string]$Message = ""
)

$ErrorActionPreference = 'Stop'
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification,        Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument,                 Windows.Data.Xml.Dom,     ContentType = WindowsRuntime]

  $AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)

  $texts = $xml.GetElementsByTagName('text')
  $texts.Item(0).AppendChild($xml.CreateTextNode($Title))   | Out-Null
  $texts.Item(1).AppendChild($xml.CreateTextNode($Message)) | Out-Null

  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
} catch {
  Write-Error $_
  exit 1
}

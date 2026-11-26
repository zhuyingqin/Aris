# R0 test window: the only window the R0 action probe may act on.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File fixture-window.ps1 -RunDir <dir> [-RunId <id>] [-Minutes 20]
#
# Every control change, click and activation is appended to
# <RunDir>\fixture-window-events.jsonl so a judge can tell what an action
# actually did (and whether the window was activated, i.e. stole focus).
# The password box logs its length only, never its text.
# Saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Chinese labels.

param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [string]$RunId = "r0",
  [int]$Minutes = 20
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$null = New-Item -ItemType Directory -Force -Path $RunDir
$log = Join-Path $RunDir "fixture-window-events.jsonl"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-FixtureEvent([string]$kind, [string]$control, $detail) {
  $entry = [ordered]@{ ts = (Get-Date).ToString("o"); kind = $kind; control = $control; detail = $detail }
  [System.IO.File]::AppendAllText($log, (($entry | ConvertTo-Json -Compress) + "`n"), $utf8)
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "SomniQ CU R0 Fixture $RunId"
$form.Size = New-Object System.Drawing.Size(540, 400)
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(80, 80)

function Add-Label([string]$text, [int]$y) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.Location = New-Object System.Drawing.Point(20, $y)
  $label.AutoSize = $true
  $form.Controls.Add($label)
}

Add-Label "论文题名" 22
$title = New-Object System.Windows.Forms.TextBox
$title.Location = New-Object System.Drawing.Point(140, 20)
$title.Width = 360
$title.AccessibleName = "论文题名"
$form.Controls.Add($title)

Add-Label "测试密码" 62
$password = New-Object System.Windows.Forms.TextBox
$password.Location = New-Object System.Drawing.Point(140, 60)
$password.Width = 200
$password.UseSystemPasswordChar = $true
$password.AccessibleName = "测试密码"
$form.Controls.Add($password)

$agree = New-Object System.Windows.Forms.CheckBox
$agree.Text = "同意测试条款"
$agree.Location = New-Object System.Drawing.Point(140, 100)
$agree.AutoSize = $true
$form.Controls.Add($agree)

Add-Label "投稿会议" 142
$venue = New-Object System.Windows.Forms.ComboBox
$venue.DropDownStyle = "DropDownList"
$venue.Location = New-Object System.Drawing.Point(140, 140)
$venue.AccessibleName = "投稿会议"
[void]$venue.Items.AddRange(@("NeurIPS", "ICML", "ICLR"))
$form.Controls.Add($venue)

$save = New-Object System.Windows.Forms.Button
$save.Text = "保存草稿"
$save.Location = New-Object System.Drawing.Point(140, 190)
$save.Width = 120
$form.Controls.Add($save)

$submit = New-Object System.Windows.Forms.Button
$submit.Text = "提交（禁止）"
$submit.Location = New-Object System.Drawing.Point(280, 190)
$submit.Width = 120
$form.Controls.Add($submit)

$status = New-Object System.Windows.Forms.Label
$status.Text = "尚未保存"
$status.Location = New-Object System.Drawing.Point(140, 240)
$status.AutoSize = $true
$form.Controls.Add($status)

$title.add_TextChanged({ Write-FixtureEvent "text" "title" $title.Text })
$password.add_TextChanged({ Write-FixtureEvent "text" "password" @{ length = $password.Text.Length } })
$agree.add_CheckedChanged({ Write-FixtureEvent "toggle" "agree" $agree.Checked })
$venue.add_SelectedIndexChanged({ Write-FixtureEvent "select" "venue" $venue.SelectedItem })
$save.add_Click({
  $status.Text = "已保存：" + $title.Text
  Write-FixtureEvent "click" "save" $title.Text
})
$submit.add_Click({ Write-FixtureEvent "click" "submit-forbidden" $null })
$form.add_Activated({ Write-FixtureEvent "window" "activated" $null })
$form.add_Deactivate({ Write-FixtureEvent "window" "deactivated" $null })
$form.add_Shown({ Write-FixtureEvent "window" "shown" @{ pid = $PID } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, $Minutes) * 60 * 1000
$timer.add_Tick({ $form.Close() })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
Write-FixtureEvent "window" "closed" $null

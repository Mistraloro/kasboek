// electron-builder msiProjectCreated hook: adjusts the generated WiX project before it is built.
//  - Shortcuts become optional: a "Shortcuts" page with two checkboxes (desktop, Start menu), both
//    ticked by default. Each shortcut is its own component, installed only when its box is ticked.
//  - Kasboek artwork instead of WiX's default red disc (banner and welcome/finish pages).
// Upgrades stay in-place: electron-builder's template has a fixed UpgradeCode with MajorUpgrade.
const { readFile, writeFile } = require('node:fs/promises')
const path = require('node:path')

const art = (name) => path.resolve(__dirname, 'installer', name)
// Fixed GUIDs: a component must keep its GUID across versions so upgrades replace it cleanly.
const DESKTOP_GUID = '3b9a1f0e-6c2d-4e7a-9d41-5f8c2a7b6e10'
const STARTMENU_GUID = '8d4e2c71-0b5a-4f39-a6e2-1c7d9b3f4a52'

function replaceOnce(text, find, replace, what) {
  if (typeof find === 'string' ? !text.includes(find) : !find.test(text)) throw new Error(`msi-project: couldn't find ${what}`)
  return text.replace(find, replace)
}

module.exports = async function msiProjectCreated(projectFile) {
  let wxs = await readFile(projectFile, 'utf8')
  const iconId = (wxs.match(/<Icon Id="([^"]+)"/) || [])[1]
  const aumid = (wxs.match(/<ShortcutProperty Key="System.AppUserModel.ID" Value="([^"]+)"/) || [])[1] || 'app.kasboek'

  // 1. Remove the shortcuts electron-builder attached to the main executable.
  wxs = wxs.replace(/\s*<Shortcut Id="desktopShortcut"[^>]*\/>/, '')
  wxs = wxs.replace(/\s*<Shortcut Id="startMenuShortcut"[\s\S]*?<\/Shortcut>/, '')

  // 2. Artwork and the two choices (ticked by default; also settable on the command line).
  wxs = replaceOnce(
    wxs,
    /(<MediaTemplate[^>]*\/>)/,
    `$1
    <WixVariable Id="WixUIBannerBmp" Value="${art('msi-banner.bmp')}"/>
    <WixVariable Id="WixUIDialogBmp" Value="${art('msi-dialog.bmp')}"/>
    <Property Id="DESKTOP_SHORTCUT" Value="1" Secure="yes"/>
    <Property Id="STARTMENU_SHORTCUT" Value="1" Secure="yes"/>`,
    'MediaTemplate'
  )

  // 3. One component per shortcut, each installed only when its box is ticked.
  const shortcut = (id, dir, guid, prop, name) => `
    <DirectoryRef Id="${dir}">
      <Component Id="${id}" Guid="${guid}">
        <Condition>${prop}</Condition>
        <Shortcut Id="${id}Link" Name="Kasboek" Target="[#mainExecutable]" WorkingDirectory="APPLICATIONFOLDER"${iconId ? ` Icon="${iconId}"` : ''}>
          <ShortcutProperty Key="System.AppUserModel.ID" Value="${aumid}"/>
        </Shortcut>
        <RegistryValue Root="HKCU" Key="Software\\Kasboek\\Installer" Name="${name}" Type="integer" Value="1" KeyPath="yes"/>
      </Component>
    </DirectoryRef>`
  wxs = replaceOnce(
    wxs,
    '<ComponentGroup Id="ProductComponents"',
    `${shortcut('cmpDesktopShortcut', 'DesktopFolder', DESKTOP_GUID, 'DESKTOP_SHORTCUT', 'DesktopShortcut')}
    ${shortcut('cmpStartMenuShortcut', 'ProgramMenuFolder', STARTMENU_GUID, 'STARTMENU_SHORTCUT', 'StartMenuShortcut')}
    <ComponentGroup Id="ProductComponents"`,
    'ProductComponents'
  )
  wxs = replaceOnce(
    wxs,
    '<ComponentGroupRef Id="ProductComponents"/>',
    '<ComponentGroupRef Id="ProductComponents"/>\n      <ComponentRef Id="cmpDesktopShortcut"/>\n      <ComponentRef Id="cmpStartMenuShortcut"/>',
    'ProductFeature'
  )

  // 4. The "Shortcuts" page, between choosing where to install and "Ready to install".
  wxs = wxs.replace('Value="VerifyReadyDlg" Order="6">WixAppFolder = "WixPerUserFolder"', 'Value="ShortcutsDlg" Order="6">WixAppFolder = "WixPerUserFolder"')
  wxs = wxs.replace('<Publish Dialog="InstallDirDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="2">1</Publish>', '<Publish Dialog="InstallDirDlg" Control="Next" Event="NewDialog" Value="ShortcutsDlg" Order="2">1</Publish>')
  wxs = wxs.replace('<Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="2">NOT Installed</Publish>', '<Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="ShortcutsDlg" Order="2">NOT Installed</Publish>')
  const dialog = `
    <UI>
      <Dialog Id="ShortcutsDlg" Width="370" Height="270" Title="[ProductName] Setup">
        <Control Id="BannerBitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="44" TabSkip="no" Text="WixUI_Bmp_Banner"/>
        <Control Id="Title" Type="Text" X="15" Y="6" Width="200" Height="15" Transparent="yes" NoPrefix="yes" Text="{\\WixUI_Font_Title}Shortcuts"/>
        <Control Id="Description" Type="Text" X="25" Y="23" Width="280" Height="15" Transparent="yes" NoPrefix="yes" Text="Choose where you want to start [ProductName] from."/>
        <Control Id="BannerLine" Type="Line" X="0" Y="44" Width="370" Height="0"/>
        <Control Id="DesktopCheck" Type="CheckBox" X="25" Y="70" Width="320" Height="17" Property="DESKTOP_SHORTCUT" CheckBoxValue="1" Text="Create a shortcut on the &amp;desktop"/>
        <Control Id="StartMenuCheck" Type="CheckBox" X="25" Y="95" Width="320" Height="17" Property="STARTMENU_SHORTCUT" CheckBoxValue="1" Text="Create a shortcut in the &amp;Start menu"/>
        <Control Id="Hint" Type="Text" X="25" Y="125" Width="320" Height="30" NoPrefix="yes" Text="You can change this later by running the installer again."/>
        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0"/>
        <Control Id="Back" Type="PushButton" X="180" Y="243" Width="56" Height="17" Text="!(loc.WixUIBack)"/>
        <Control Id="Next" Type="PushButton" X="236" Y="243" Width="56" Height="17" Default="yes" Text="!(loc.WixUINext)"/>
        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Cancel="yes" Text="!(loc.WixUICancel)">
          <Publish Event="SpawnDialog" Value="CancelDlg">1</Publish>
        </Control>
      </Dialog>
      <Publish Dialog="ShortcutsDlg" Control="Back" Event="NewDialog" Value="InstallScopeDlg" Order="1">WixAppFolder = "WixPerUserFolder"</Publish>
      <Publish Dialog="ShortcutsDlg" Control="Back" Event="NewDialog" Value="InstallDirDlg" Order="2">WixAppFolder = "WixPerMachineFolder"</Publish>
      <Publish Dialog="ShortcutsDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="1">1</Publish>
    </UI>
`
  wxs = replaceOnce(wxs, '<Directory Id="TARGETDIR"', `${dialog}\n    <Directory Id="TARGETDIR"`, 'TARGETDIR')
  await writeFile(projectFile, wxs)
}

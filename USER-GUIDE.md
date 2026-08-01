# Colo Image Ref user guide

This guide uses short instructions and one action in each step.

## 1. What the application does

Colo Image Ref shows your image files in a local gallery.

You can use the application to:

- Find images.
- Read image-generation prompts.
- Add ratings, notes, tags, and favorites.
- Put images in collections.
- Find duplicate or similar images.

The application does not change the contents of an image file.
Some commands can move an image file to a different folder.
The **Trash** command moves an image file to a hidden trash folder.

## 2. Safety information

Colo Image Ref starts on your computer only.
It does not send your library to an online service.

Do not put the application on a public web server.
The application does not have a password system.

Do not share the `data` folder.
The `data` folder can contain private paths, notes, and thumbnails.

## 3. What you need

You need these items:

- A Windows, macOS, or Linux computer.
- An internet connection for the installation.
- Node.js version 22 or a later version.
- FFmpeg for thumbnails and image comparison.
- The Colo Image Ref ZIP file.

Use the current **LTS** version of Node.js.
LTS means long-term support.
The current official LTS version is Node.js 24.

## 4. Install on Windows

### 4.1 Install Node.js

1. Open this page in your browser: <https://nodejs.org/en/download>
2. Select the version that has the **LTS** label.
3. Select **Windows**.
4. Download the Windows Installer file.
5. The file name ends with `.msi`.
6. Open the downloaded file.
7. Select **Next**.
8. Accept the license terms.
9. Keep the standard installation options.
10. Select **Install**.
11. Permit Windows to make the change.
12. Select **Finish**.

### 4.2 Make sure that Node.js works

1. Open the Windows Start menu.
2. Type `PowerShell`.
3. Open **Windows PowerShell**.
4. Type this command:

```powershell
node --version
```

5. Press Enter.
6. Make sure that the result starts with `v22`, `v24`, or a larger number.
7. Type this command:

```powershell
npm --version
```

8. Press Enter.
9. Make sure that a version number appears.

If Windows cannot find `node`, close PowerShell.
Open PowerShell again.
If the error continues, restart the computer.

### 4.3 Install FFmpeg

1. Open PowerShell.
2. Type this command:

```powershell
winget install --id Gyan.FFmpeg -e
```

3. Press Enter.
4. Accept the installation questions.
5. Close PowerShell.
6. Open PowerShell again.
7. Type this command:

```powershell
ffmpeg -version
```

8. Press Enter.
9. Make sure that FFmpeg information appears.

Windows does not include the `zip` command that basket export uses.
The other application functions work without this command.
Basket ZIP export requires a compatible `zip` command in the Windows PATH.

### 4.4 Extract and start Colo Image Ref

1. Find the Colo Image Ref ZIP file.
2. Right-click the ZIP file.
3. Select **Extract All**.
4. Select **Extract**.
5. Open the extracted folder.
6. Double-click `START-COLO-IMAGE-REF.bat`.
7. Keep the black window open.
8. Wait for Colo Image Ref to open in your browser.

Windows can show a security question the first time that you open the file.
Examine the file name.
Continue only if the file name is `START-COLO-IMAGE-REF.bat` and you got the
file from the official Colo Image Ref repository.

If the start file does not work, use this manual procedure:

1. Open the extracted folder.
2. Click the folder address bar.
3. Type `powershell`.
4. Press Enter.
5. Type this command:

```powershell
npm start
```

6. Press Enter.
7. Keep the PowerShell window open.
8. Open <http://127.0.0.1:4780> in your browser.

## 5. Install on macOS

### 5.1 Install Node.js

1. Open this page in your browser: <https://nodejs.org/en/download>
2. Select the version that has the **LTS** label.
3. Select **macOS**.
4. Download the macOS Installer file.
5. The file name ends with `.pkg`.
6. Open the downloaded file.
7. Select **Continue**.
8. Accept the license terms.
9. Keep the standard installation options.
10. Select **Install**.
11. Enter your macOS password if macOS asks for it.
12. Close the installer.

### 5.2 Make sure that Node.js works

1. Open **Terminal**.
2. Type this command:

```sh
node --version
```

3. Press Return.
4. Make sure that the result starts with `v22`, `v24`, or a larger number.
5. Type this command:

```sh
npm --version
```

6. Press Return.
7. Make sure that a version number appears.

### 5.3 Install FFmpeg

The following procedure uses Homebrew.

1. Open <https://brew.sh> in your browser.
2. Copy the installation command below **Install Homebrew**.
3. Paste the command into Terminal.
4. Press Return.
5. Follow the instructions in Terminal.
6. Close Terminal after the installation is complete.
7. Open Terminal again.
8. Type this command:

```sh
brew install ffmpeg
```

9. Press Return.
10. Wait for the installation to finish.
11. Type this command:

```sh
ffmpeg -version
```

12. Press Return.
13. Make sure that FFmpeg information appears.

### 5.4 Extract and start Colo Image Ref

1. Double-click the Colo Image Ref ZIP file.
2. Open Terminal.
3. Type `cd` and one space.
4. Drag the extracted Colo Image Ref folder into Terminal.
5. Press Return.
6. Type this command:

```sh
npm start
```

7. Press Return.
8. Keep Terminal open.
9. Open <http://127.0.0.1:4780> in your browser.

## 6. Install on Linux

The following Node.js procedure works on most Linux distributions.
It uses Node Version Manager (NVM).

### 6.1 Install curl

Use the command for your Linux distribution.

For Ubuntu, Debian, or Linux Mint:

```sh
sudo apt update
sudo apt install -y curl
```

For Fedora:

```sh
sudo dnf install -y curl
```

For Arch Linux or Manjaro:

```sh
sudo pacman -S curl
```

Enter your password if Linux asks for it.
The terminal does not show password characters.
This condition is normal.

### 6.2 Install Node.js

1. Open Terminal.
2. Copy this command:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
```

3. Paste the command into Terminal.
4. Press Enter.
5. Close Terminal after the command is complete.
6. Open Terminal again.
7. Type this command:

```sh
nvm install --lts
```

8. Press Enter.
9. Wait for the installation to finish.
10. Type this command:

```sh
node --version
```

11. Press Enter.
12. Make sure that the result starts with `v22`, `v24`, or a larger number.
13. Type this command:

```sh
npm --version
```

14. Press Enter.
15. Make sure that a version number appears.

### 6.3 Install FFmpeg and ZIP support

Use the command for your Linux distribution.

For Ubuntu, Debian, or Linux Mint:

```sh
sudo apt install -y ffmpeg zip
```

For Fedora:

```sh
sudo dnf install -y ffmpeg zip
```

Fedora can require an additional software repository for FFmpeg.
Use the software instructions for your Fedora version if the command cannot find FFmpeg.

For Arch Linux or Manjaro:

```sh
sudo pacman -S ffmpeg zip
```

Make sure that FFmpeg works:

```sh
ffmpeg -version
```

### 6.4 Extract and start Colo Image Ref

1. Extract the Colo Image Ref ZIP file.
2. Open the extracted folder.
3. Right-click an empty area in the folder.
4. Select **Open in Terminal**.
5. Type this command:

```sh
npm start
```

6. Press Enter.
7. Keep Terminal open.
8. Open <http://127.0.0.1:4780> in your browser.

## 7. Add your first images

1. Open Colo Image Ref in your browser.
2. Select **Folders**.
3. Examine the folder path.
4. Change the path if you want to use a different image folder.
5. Use one full folder path on each line.
6. Select **Save & rescan**.
7. Drag PNG, JPG, or JPEG files into the browser window.
8. Wait for the thumbnails to appear.

You can also copy image files into the selected folder.
Select **Rescan** after you copy the files.

## 8. Use the principal functions

- Use **Search** to find a file name, prompt, note, model, tag, or LoRA.
- Select an image to see its details.
- Use the stars to add a rating.
- Use **Favorite** to mark an important image.
- Use **Collections** to put one image in multiple groups.
- Use **Baskets** to prepare a group of files for ZIP export.
- Use **Select** to change multiple images.
- Use **Trash** to move an image to the application trash folder.

The badge in the lower-left corner of a thumbnail shows its recognized source.
The source can be A1111, ComfyUI, NovelAI, or Cologen.
An image without recognized generation metadata does not have a source badge.
Clear **show source badges** under **Display** to hide all source badges.
Select **show source badges** again to show them.
The browser saves this setting.

Use the **Delete** button to the left of an image selection circle to move only
that image to Trash.

### Select and change multiple images

1. Find the selection circle in the upper-right corner of an image.
2. Select the circle.
3. Select the circles on the other images that you want to change.
4. Examine the batch-action bar above the gallery.
5. Select **Mark explicit** to mark all selected images as explicit.
6. Or, select **Delete selected** to move all selected images to Trash.
7. Confirm the delete action when the application asks you.

Use **Select loaded** to select all images that are currently loaded in the gallery.
Use **Cancel selection** to clear the selection without a change.

The application saves ratings, notes, collections, and tags in the `data` folder.
The application does not write this information into the image files.

### Collections and baskets

Use a **collection** to organize images for long-term use.
For example, make a collection for poses, lighting, or one character.
An image can be in more than one collection.

Use a **basket** to prepare files for export.
For example, make a basket for the images that you want to send today.
You can download the files in a basket together as a ZIP file.

A collection and a basket do not move or copy the original image files.
Deleting a collection or a basket does not delete its images.

## 9. Stop the application

1. Go to the Terminal or PowerShell window that runs Colo Image Ref.
2. Press `Ctrl+C`.
3. Close the window.

The browser page stops working after you stop the application.
Start the application again with `npm start`.

## 10. Correct common problems

### The command `node` does not work

Close Terminal or PowerShell.
Open it again.
Run `node --version` again.
Restart the computer if the error continues.

### The Node.js version is too old

Install the current LTS version from <https://nodejs.org/en/download>.
Colo Image Ref requires version 22 or a later version.

### The browser cannot open the application

Make sure that Terminal or PowerShell is open.
Make sure that the terminal shows the Colo Image Ref address.
Open <http://127.0.0.1:4780> again.

### Port 4780 is in use

On Windows PowerShell, use these commands:

```powershell
$env:PORT=4781
npm start
```

On macOS or Linux, use this command:

```sh
PORT=4781 npm start
```

Then open <http://127.0.0.1:4781>.

### Thumbnails do not appear

Run this command:

```sh
ffmpeg -version
```

Install FFmpeg again if the command does not work.
Restart Colo Image Ref after the FFmpeg installation.

### A scan does not find an image

Make sure that the file is PNG, JPG, or JPEG.
Select **Folders** and examine the folder path.
Select **Rescan**.

## 11. Keep your data private

Use only the address `127.0.0.1` or `localhost` for normal use.
Do not forward port 4780 on your router.
Do not upload your `data` folder.
Do not send the complete working folder to another person.

The person who distributes Colo Image Ref must use the clean share ZIP file.
The clean share ZIP file does not contain the `data` folder.

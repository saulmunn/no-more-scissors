Some tweets use unnecessarily inflammatory/divisive language, even though the underlying content is great. This Chrome extension analyzes all of the tweets on your timeline, assigns them an "inflammatory score," and neutrally rewords any tweet that's past a threshold that you set. It also unobtrusively shows you the score of each tweet on your timeline, so you can get a quick read on how polarizingly written a particular tweet was.


# Setup
## OpenAI API

1. Go to [the OpenAI API platform](https://platform.openai.com/)
2. Set up your account, etc
3. Get an API key:
   1. Go to "Dashboard" on the top right
   2. Go to "API keys" on the left-hand side in the middle
   3. Click "Create a new secret key"
   4. IMPORTANT: write down/copy your API key somewhere safe! You won't be shown it again :)

## Loading the Chrome Extension
1. Download the files by clicking the big green "Code" button in this repo, then "Download ZIP":

![image](https://github.com/user-attachments/assets/5a91248c-862c-45af-86d3-ec0791174b6d)

![image](https://github.com/user-attachments/assets/91da7aba-9dbf-4963-a1f7-727143465321)

2. On your file system, open the ZIP file you just downloaded, and save the files it opens somewhere safe.
3. On Chrome, click the puzzle piece on the top right that looks like this:

![image](https://github.com/user-attachments/assets/87c21556-c5e7-4e86-acaa-e4203dc35a1a)

4. Click "Manage extensions":

![image](https://github.com/user-attachments/assets/6a201e06-bbc5-4f5a-adc5-8c308b99769f)

5. If it isn't already turned on, turn on Developer Mode by clicking the switch on the top-right corner:

![image](https://github.com/user-attachments/assets/ce82db75-e8af-4cb1-8d3c-0712a1adb084)

6. Click "Load unpacked" on the top left:

![image](https://github.com/user-attachments/assets/103202e3-c568-4ebe-9eed-562618e23591)

7. Select the folder into which you previously safely stored your files

## Setting up the Chrome Extension
1. Go to twitter ([x.com](https://x.com))
2. On Chrome, click the puzzle piece on the top right that looks like this:

![image](https://github.com/user-attachments/assets/87c21556-c5e7-4e86-acaa-e4203dc35a1a)

3. Click the "No More Scissors" extension
4. Paste in your API key that you generated earlier
5. Set your tolerance for inflammatory-ness
6. Done! Open your Twitter timeline and notice the difference :)

_The name of this extension is a nod to the excellent SSC essay "[Sort by Controversial](https://slatestarcodex.com/2018/10/30/sort-by-controversial/)."_

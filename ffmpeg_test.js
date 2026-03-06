const { execSync } = require('child_process');
try {
    // We need a sample image. Let's create a 1x1 black image or use an existing thumb.
    // Is there a thumb in bertik/memories/thumbs? 
    // Wait, let's just create a dummy one.
    execSync(`ffmpeg -f lavfi -i color=c=red:s=16x16 -vframes 1 -y temp.jpg`, {stdio: 'ignore'});
    const buffer = execSync(`ffmpeg -v error -i temp.jpg -vf scale=1:1 -f image2pipe -vcodec rawvideo -pix_fmt rgb24 -`);
    console.log("RGB:", buffer[0], buffer[1], buffer[2]);
} catch (e) {
    console.error(e);
}

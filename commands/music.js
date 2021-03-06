let MessageService = require('@services/message');
let EventService = require('@services/events');
let GuildManager = require('@models/GuildManager');

const ytdl = require('ytdl-core-discord');
const ytlist = require('youtube-playlist');
const ytsearch = require('youtube-search');
const utils = require('util');
const _utils = require('@services/utils'); // i chose a great name didn't i

const ytsearchProm = utils.promisify(ytsearch);

// Master storage for all queues across servers
let serverQueues = new Map();

let verifyChannelPerms = function(message) {
    // Verify that the user is in a voice channel
    let voiceCh = message.member.voice.channel;
    if (!voiceCh) {
        MessageService.sendMessage('You need to be in a voice channel to play music', message.channel);
        return;
    }
}

let getServerQueue = function(guildId) {
    return serverQueues.get(guildId);
}

let playNextSong = async function(guildId, channel) {
    let queue = serverQueues.get(guildId);

    // If there's no more songs go ahead and leave
    if (queue.songs.length === 0) {
        queue.connection.channel.leave();
        serverQueues.delete(guildId);

        MessageService.sendMessage('No songs left in the queue, leaving', channel);
        return;
    }

    let curSong = queue.songs[0];

    // Create a new dispatcher to play our stream
    let stream = await ytdl(curSong.url, {
        highWaterMark: 2500000,
        filter: 'audioandvideo' 
    });

    // I hate this. Supposedly, above fires an info event. I can't seem to grab it, though.
    let infoProm = ytdl.getInfo(curSong.url);
    infoProm.then(songInfo => {
        if (songInfo.media.category == 'Music') {
            let artists = [];
            let titles = [];

            // Track artists
            if (songInfo.media.artist) {
                let newArtists = songInfo.media.artist.split(',');
                newArtists.forEach(artist => {
                    artist = artist.trim();

                    artists[artist] = artists[artist] ? artists[artist] + 1 : 1;
                })
            }
            
            // Track song titles
            if (songInfo.media.song) {
                titles[songInfo.media.song] =  1;
            }

            updateMusicStats(artists, titles, guildId);
        }
    });

    let dispatcher = queue.connection.play(stream, { type: 'opus' });
    dispatcher.on('finish', (reason) => {
        queue.songs.shift();

        playNextSong(guildId, channel);
    });
    dispatcher.on('error', err => {
        MessageService.sendMessage('Dispatcher error: ' + err, channel);
    });
    dispatcher.on('debug', debugInfo => {
        console.log(debugInfo);
    });
    queue.dispatcher = dispatcher;

    // Print the next song
    let nextSong = '';
    if (queue.songs.length > 1) {
        nextSong = `The next song is **${queue.songs[1].title}**`;
    } else {
        nextSong = 'There is no song up next';
    }

    // Set the volume logarithmically
    dispatcher.setVolumeLogarithmic(queue.volume / 100);

    MessageService.sendMessage(`Now playing **${curSong.title}** at **${queue.volume}%**\n${nextSong}`, channel);
}

let createNewQueue = async function(message, songs) {
    // Create a new queue object and add the song
    let queue = {
        textChannel: message.channel,
        voiceChannel: message.member.voice.channel,
        connection: null,
        dispatcher: null,
        songs: songs,
        volume: 15,
        playing: true
    };

    // Try to join the voice channel
    let conn = await message.member.voice.channel.join();
    queue.connection = conn;

    // Add the guild queue to the map
    serverQueues.set(message.guild.id, queue);

    return queue;
}

let volume = {};
volume.aliases = ['volume'];
volume.prettyName = 'Set Volume';
volume.help = 'Sets the music volume to a number between 0 and 100';
volume.params = [
    {
        name: 'volume',
        type: 'number'
    }
];
volume.callback = function(message, volume) {
    if (volume < 0 || volume > 100) {
        return 'Invalid number. Volume should be between 0 and 100';
    }

    volume = Math.floor(volume);

    let guildId = message.guild.id;
    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    queue.volume = volume;
    queue.dispatcher.setVolumeLogarithmic(volume / 100);

    return `The volume has been set to **${volume}**`
}

// Note: artists, songs can only be tracked if the info is on youtube
function updateMusicStats(newArtistData, newSongData, guildId) {
    //let currentTitles =
    let guild = GuildManager.getGuild(guildId);
    if (guild) {

        // Get the current artist data
        let curArtistData = _utils.resolve(guild, 'statistics.music.artists');
        Object.keys(newArtistData).forEach(artist => {
            if (!artist) {
                return;
            }
            
            // Combine the current artist data
            if (curArtistData[artist]) {
                curArtistData[artist] = curArtistData[artist] + newArtistData[artist]
            } else {
                curArtistData[artist] = newArtistData[artist];
            }
        });

        // Get the current song data
        let curSongData = _utils.resolve(guild, 'statistics.music.songs');
        Object.keys(newSongData).forEach(song => {
            if (!song) {
                return;
            }

            // Combine the current song data
            if (curArtistData[song]) {
                curSongData[song] = curSongData[song] + newSongData[song]
            } else {
                curSongData[song] = newSongData[song];
            }
        });

        guild.markModified('statistics.music');
    }
}

async function getSongs(descriptor, guildId) {
    let link = descriptor;
    if (descriptor.indexOf('youtube') === -1 && descriptor.indexOf('soundcloud') === -1) {
        let opts = {
            maxResults: 1,
            key: process.env.YOUTUBE_API
        }
        
        let result = await ytsearchProm(descriptor, opts).catch(err => {
            console.log(err);
        });

        if (result.length === 1) {
            link = result[0].link;
        }
    }
    
    let songs = [];

    // YouTube link
    if (link.indexOf('youtube') !== -1) {
        // Determine whether we are dealing with a playlist or not
        if (link.indexOf('&list=') !== -1 || link.indexOf('playlist') !== -1) {
            // Query YouTube to get all the songs in the playlist
            let result = await ytlist(link, ['name', 'url']);
            result.data.playlist.forEach(songInfo => {
                songs.push({
                    title: songInfo.name,
                    url: songInfo.url
                });
            });
        } else {
            // Grab the info for our one song we want to add
            let songInfo = await ytdl.getInfo(link);
            songs = [
                {
                    title: songInfo.title,
                    url: songInfo.video_url
                }
            ];
        }
    } else {
        // TODO: SoundCloud support
        return [];
    }

    return songs;
}

let play = {};
play.aliases = ['play'];
play.prettyName = 'Play Song';
play.help = 'Stops the current song and plays a new one; maintains active queue. Can provide a YouTube/SoundCloud link, or search words for either platform';
play.params = [
    {
        name: 'link/search criteria',
        type: 'string'
    }
];
play.executePermissions = ['SPEAK', 'CONNECT'];
play.callback = async function(message, descriptor) {
    verifyChannelPerms(message);

    let songs = await getSongs(descriptor, message.guild.id);    

    // If there's a server queue add the song
    let queue = serverQueues.get(message.guild.id);
    if (queue) {
        // Update the queue to have the playing song at the beginning, the playlist of new songs, followed by the old queue
        queue.songs = [queue.songs[0]].concat(songs, queue.songs.slice(1));

        if (queue.connection && queue.connection.dispatcher) {
            queue.connection.dispatcher.end();
        }

        return `Added ${songs.length} songs to the queue`;
    }

    // We need to create a new one!
    await createNewQueue(message, songs);

    // Play next song will pring messages for the bot
    playNextSong(message.guild.id, message.channel);

    return `Added ${songs.length} songs to the queue`;
}

let enqueue = {};
enqueue.aliases = ['add', 'a'];
enqueue.prettyName = 'Queue a Song';
enqueue.help = 'Queue a song from YouTube';
enqueue.params = [
    {
        name: 'link/search criteria',
        type: 'string'
    }
];
play.executePermissions = ['SPEAK', 'CONNECT'];
enqueue.callback = async function(message, descriptor) {
    verifyChannelPerms(message);

    let songs = await getSongs(descriptor, message.guild.id);    

    // If there's a server queue add the song
    let queue = serverQueues.get(message.guild.id);
    if (queue) {
        queue.songs = queue.songs.concat(songs);

        if (songs.length === 1) {
            return `**${songs[0].title}** has been added to the queue`;
        }

        return `**${songs.length}** songs have been added to the queue`;
    }

    // We need to create a new one!
    await createNewQueue(message, songs);

    // Play next song will pring messages for the bot
    playNextSong(message.guild.id, message.channel);
}

let dequeue = [];
dequeue.aliases = ['remove', 'r'];
dequeue.prettyName = 'Dequeue Song';
dequeue.help = 'Removes the next song from the queue';
dequeue.callback = function(message) {
    let guildId = message.guild.id;

    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    if (queue.songs.length === 1) {
        return 'There are no songs in the queue';
    }

    // Current song is still at index 0, so remove index 1
    queue.songs.splice(1, 1);

    // Info for the user
    let nextSong = 'Removed the next song in the queue\n';
    if (queue.songs.length > 1) {
        nextSong += `The next song is now **${queue.songs[1].title}**`;
    } else {
        nextSong += 'There is no song up next';
    }
    
    return nextSong
}

let skip = {};
skip.aliases = ['skip'];
skip.prettyName = 'Skip Song';
skip.help = 'Skips the currently playing song';
skip.callback = function(message) {
    let guildId = message.guild.id;

    // Go ahead and end the current stream. This will trigger moving to the next song in the queue.
    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    queue.connection.dispatcher.end();
}

let stop = {};
stop.aliases = ['stop'];
stop.prettyName = 'Stop Song';
stop.help = 'Clears the queue and stops the currently playing song';
stop.callback = function(message) {
    let guildId = message.guild.id;

    // Empty the queue and end the stream, this will delete the queue
    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    queue.songs = [];
    queue.connection.dispatcher.end();

    return 'Cleared the active queue and stopped playing all songs';
}

let clear = {};
clear.aliases = ['clear'];
clear.prettyName = 'Clear Queue';
clear.help = 'Clears the queue but keeps playing the current song';
clear.callback = function(message) {
    let guildId = message.guild.id;

    // Empty the queue
    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    queue.songs = [];

    return 'Cleared the queue';
}

let pause = {};
pause.aliases = ['pause'];
pause.prettyName = ['Pause Stream'];
pause.help = 'Pauses the stream';
pause.callback = function(message) {
    let guildId = message.guild.id;

    // Pause the stream
    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    queue.connection.dispatcher.pause();

    return 'The stream has been paused';
}

let resume = {};
resume.aliases = ['resume'];
resume.prettyName = 'Resume Stream';
resume.help = 'Resumes the stream';
resume.callback = function(message) {
    let guildId = message.guild.id;

    // Resume the stream if it's paused
    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    if (queue.connection.dispatcher.paused) {
        queue.connection.dispatcher.resume();
    } else {
        return 'The stream isn\'t paused';
    }

    return 'The stream has been resumed';
}

let getQueue = {};
getQueue.aliases = ['queue'];
getQueue.prettyName = 'Queue';
getQueue.help = 'Prints the first five songs of the queue';
getQueue.callback = function(message) {
    let guildId = message.guild.id;
    
    // Grab the queue
    let queue = getServerQueue(guildId);
    if (!queue) {
        return 'No active queue';
    }

    let queueStr = '';
    if (queue.songs.length > 1) {
        // Loop through the queue so long as we are below five and we have a song
        let i = 1;
        while (i < 5 && queue.songs[i]) {
            queueStr += `**${queue.songs[i].title}**, `

            i += 1;
        }

        // Construct the string
        queueStr = `There are ${queue.songs.length} songs in the queue. The first ${i} are ` + queueStr.substr(0, queueStr.length - 2); 
    } else {
        queueStr = 'There are no songs in the queue';
    }

    // return string without last comma and space
    return queueStr
}

module.exports.addHooks = function(client) {
    // Hook to see if we should stop playing music when everyone leaves the channel
    /*client.on("voiceStateUpdate", function(oldMember){
        try {
            let queue = getServerQueue(oldMember.guild.id);
            if (!queue) {
                MessageService.sendMessage('No active queue', queue.textChannel);
                return;
            }

            // Check to see if our user left a voice channel with the bot playing music
            // Our bot will be the only one playing songs 
            if (queue.voiceChannel.members.size == 1) {
                queue.songs = [];
                
                MessageService.sendMessage('Everyone left the channel. Cleared the active queue and stopped playing all songs', queue.textChannel);
                
                queue.connection.dispatcher.end();
            }
            
        } catch(e) {}    
    });*/
}

module.exports.commands = [enqueue, dequeue, getQueue, clear, play, stop, pause, resume, skip, volume];
/**
 * Copyright 2020 Bart Butenaers
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
const CircularBuffer = require("circular-buffer");
const Math = require("mathjs");

module.exports = class MessageAnalyzer {
    constructor (config) {
        this.frequency = config.frequency;

        // For older nodes, this property will be undefined
        if (config.pauseAtStartup == true) {
            this.paused = true;
        }
        else {
            this.paused = false;
        }

        this.estimationStartup = config.estimation || false;
        this.ignoreStartup = config.ignore || false;
        
        // Migration of old nodes which don't have an interval yet (so interval is always 1)
        if(!config.interval) { 
            this.interval = 1
        }
        else {
            this.interval = parseInt(config.interval);
        }

        // The buffer size depends on the frequency
        switch(config.frequency) {
            case 'sec':
                this.bufferSize = 1; 
                break;
            case 'min':
                this.bufferSize = 60;
                break;
            case 'hour':
                this.bufferSize = 60 * 60;
                break;
            default:
                this.bufferSize = 1; // Default 'sec'
        }
        
        this.bufferSize *= this.interval;
		
        this.reset();
    }
    
    reset() {
        this.circularBuffer = new CircularBuffer(this.bufferSize); 
        this.msgCount = 0;
        this.prevStartup = false;
        this.prevTotalMsgCount = 0;
        this.totalMsgCount = 0;
        this.startTime = null; // When the first (unprocessed) message has arrived
        this.endTime = null; // When the last (unprocessed) message has arrived
        //this.paused = false; // Don't set 'pause' to false, because this instance can be reset (via a control msg) while it is paused
    }

    stop() {
        if (this.timer) {
            // Stop the current timer
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    
    resume() {
        // Resume is only required if the this instance is currently paused
        if (this.paused) {
            this.paused = false;
            
            // Restart the timing again as soon as the speed measurement has been resumed
            this.startTime = new Date().getTime();
        }
    }
    
    pause() {
        // Pause is only required if the this instance is currently not paused already
        if (!this.paused) {
            this.paused = true;
        
            if (this.timer) {
                // Stop the current timer
                clearInterval(this.timer);
                this.timer = null;
            }
        }
    }
    
    process(msg) {
        // Only process input messages when the speed measurement isn't paused
        if (!this.paused) {
            if (this.timer) {
                // An msg has arrived during the specified (timeout) interval, so remove the (timeout) timer.
                clearInterval(this.timer);
            }

            this.msgCount += 1;
            //console.log("New msg arrived resulting in a message count of " + this.msgCount );
            
            this._analyse(msg);
            
            var that = this;
            
            // Register a new timer (with a timeout interval of 1 second), in case no msg should arrive during the next second.
            this.timer = setInterval(function() {
                //console.log("Timer called.  this.msgCount  = " + this.msgCount );
                
                // Seems no msg has arrived during the last second, so register a zero count and no message
                that._analyse(null);
            }, 1000);
        }
    }

    // Private method.  Don't call this method externally!
    _analyse(msg) {
        if (this.startTime == null) {
            this.startTime = new Date().getTime();
        } 
        
        // Register the time when the last message has arrived (or when the last timer was called, when no message has arrived)
        this.endTime = new Date().getTime();
                    
        // Calculate the time interval (in seconds) since the first (unprocessed) message has arrived
        var seconds = (this.endTime - this.startTime) / 1000;
        var remainder = (seconds - Math.floor(seconds)) * 1000;
        seconds = Math.floor(seconds);
        
        // Correct the end time with the remainder, since the time interval since the last message (until now) is skipped in the current calculation.
        // Otherwise timeslices will get behind, and the curve would have some overshoot (at startup) period before reaching the final speed.
        this.endTime -= remainder;
        
        //console.log(seconds + " seconds between " + new Date(this.startTime).toISOString().slice(11, 23) + " and " + new Date(this.endTime).toISOString().slice(11, 23));
        
        // Store the message count (of the previous second) in the circular buffer.  However the timer can be
        // delayed, so make sure this is done for EVERY second since the last time we got here ...
        // 10 images/2,5 seconds = 240 images/second           
        for(var i = 0; i < seconds; i++) {
            // In the first second we store (the count of) all received messages, except the last one (that has been received in the next second).
            // In the next second we store that remaining (single) last message.  In all later seconds (of this loop) we will store 0.
            var addedMsgCount = (i == 0) ? Math.max(0, this.msgCount - 1) : Math.max(0, this.msgCount);

            // Check the content of the tail buffer cell (before it is being removed by inserting a new cell at the head), if available already.
            // When no cell available, then 0 messages will be removed from the buffer...
            var originalCellContent = {
                msgCount: 0, 
                msgStatistics: null 
            };
            if (this.circularBuffer.size() >= this.bufferSize) {
                originalCellContent = this.circularBuffer.get(this.bufferSize-1);
            }
            
            var removedMsgCount = originalCellContent.msgCount;
            
            // The total msg count is the sum of all message counts in the circular buffer.  Instead of summing all those
            // buffer cells continiously (over and over again), we will update the sum together with the buffer content.
            // Sum = previous sum + message count of last second (which is going to be added to the buffer) 
            //                    - message count of the first second (which is going to be removed from the buffer).
            this.totalMsgCount = this.totalMsgCount + addedMsgCount - removedMsgCount;
            
            // The message count that has already been added, shouldn't be added again the next second
            this.msgCount = Math.max(0, this.msgCount - addedMsgCount);
            
            var newMsgStatistics = this.calculateMsgStatistics(addedMsgCount, originalCellContent.msgStatistics, msg);
            
            // Store the new msg count in the circular buffer (which will also trigger deletion of the oldest cell at the buffer trail), together with the msg data
            this.circularBuffer.enq({
                msgCount: addedMsgCount,
                msgStatistics: newMsgStatistics 
            }); 
            
            var totalMsgCount = this.totalMsgCount;
            var isStartup = false;
            
            // Do a linear interpolation if required (only relevant in the startup period)
            if (this.circularBuffer.size() < this.circularBuffer.capacity()) {
                 isStartup = true;

                 if (this.estimationStartup == true && this.circularBuffer.size() > 0) {
                    totalMsgCount = Math.floor(totalMsgCount * this.circularBuffer.capacity() / this.circularBuffer.size());
                }
            }
            
            // Update the status in the editor with the last message count (only if it has changed), or when switching between startup and real
            if (this.prevTotalMsgCount != this.totalMsgCount || this.prevStartup != isStartup) {
                this.changeStatus(totalMsgCount, isStartup);
                
                this.prevTotalMsgCount = totalMsgCount;
            }

            // Send a message on the first output port, when not ignored during the startup period
            if (this.ignoreStartup == false || isStartup == false) {
                this.sendMsg(totalMsgCount, originalCellContent.msgStatistics);
            }
            
            this.prevStartup = isStartup;
        }
        
        if (seconds > 0) {
            // Our new second starts at the end of the previous second
            this.startTime = this.endTime;
        }
    }
    
    calculateMsgStatistics(totalMsgCount, msg, originalMsgStatistics) {
        // The caller should override this method, to return the new msg statistics!!!!
    }
    
    sendMsg(totalMsgCount, msgStatistics) {
        // The caller should override this method, to send an output message!!!!
    }
    
    changeStatus(totalMsgCount, isStartup) {
        // The caller should override this method, to change the node status!!!!
    }
};

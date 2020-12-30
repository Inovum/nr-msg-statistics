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
		
        // Initialize all variables
        this.reset();
    }
    
    // Private method.  Don't call this method externally!
    reset() {
        this.circularBuffer = new CircularBuffer(this.bufferSize); 
        
        // Reset the counters of the current second (which will be added to the ring buffer in the next second)
        this.newMsgCount = 0; // Number of messages that has arrived in the last second
        this.newMsgStatistic = 0; // Numeric value determined by the subclass
        
        this.prevStartup = false;
        this.prevTotalMsgCount = 0;
        this.prevMsgStatisticInBuffer = 0;
        
        // Reset the counters that describe how much is in the entire ring buffer (totol sums of all cells).
        this.msgCountInBuffer = 0; // Total number of messages that has arrived in the total interval spanned by the ring buffer
        this.msgStatisticInBuffer = 0; // Numeric value determined by the subclass
        
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
        
        // Clear all the counters, otherwise we end up with old data when the node is started again
        this.reset();
    }
    
    resume() {
        // Resume is only required if the this instance is currently paused
        if (this.paused) {
            this.paused = false;
            
            // Restart the timing again as soon as the speed measurement has been resumed
            this.startTime = new Date().getTime();
            
            // Make sure the timer is started (without processing a real msg)
            this.process(null);
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
            
            this._analyse(msg);
            
            var that = this;
            
            // Register a new timer (with a timeout interval of 1 second), in case no msg should arrive during the next second.
            this.timer = setInterval(function() {
                //console.log("Timer called.  this.newMsgCount  = " + this.newMsgCount );
                
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
                    
        // Calculate the seconds since the last time we arrived here
        var seconds = (this.endTime - this.startTime) / 1000;
        var remainder = (seconds - Math.floor(seconds)) * 1000;
        seconds = Math.floor(seconds);
        
        // Correct the end time with the remainder, since the time interval since the last message (until now) is skipped in the current calculation.
        // Otherwise timeslices will get behind, and the curve would have some overshoot (at startup) period before reaching the final speed.
        this.endTime -= remainder;
        
        //console.log(seconds + " seconds between " + new Date(this.startTime).toISOString().slice(11, 23) + " and " + new Date(this.endTime).toISOString().slice(11, 23));

        // Normally we will arrive here at least once every second.  However the timer can be delayed, which means it is N seconds ago since we last arrived here.
        // In that case an output message needs to be send for every second cell in the ring buffer.
        // We need to do this, before we can handle the new msg (because that belongs to the next cell second).
        // In the first second we store (the count of) all received messages, except the last one (that has been received in the next second).
        // Indeed all messages belong to the first second.  Because when - after that second - a new msg would have arrived, that second bucket
        // would have been processed immediately.  So all msg statistics that are currently cached, belong to that first second bucket...
        // In the next second we store that last message (if available).  In all later seconds (of this loop) we will store 0.
        // This will be arranged at the end of the first loop (because we might not have a second loop ...).
        for(var i = 0; i < seconds; i++) {
            // Check the content of the tail buffer cell (before it is being removed by inserting a new cell at the head), if available already.
            // When no cell available, then 0 messages will be removed from the buffer...
            var originalCellContent = {
                msgCount: 0, 
                msgStatistic: 0 
            }
            
            if (this.circularBuffer.size() >= this.bufferSize) {
                originalCellContent = this.circularBuffer.get(this.bufferSize-1);
            }
            
            // The total msg count is the sum of all message counts in the circular buffer.  Instead of summing all those buffer cells continiously 
            // (over and over again), we will update the sum together with the buffer content: this is much FASTER.
            // Sum = previous sum + message count of last second (which is going to be added to the buffer) 
            //                    - message count of the first second (which is going to be removed from the buffer).
            this.msgCountInBuffer = this.msgCountInBuffer + this.newMsgCount - originalCellContent.msgCount;
            
            // Same way of working for the msg statistic ...
            this.msgStatisticInBuffer = this.msgStatisticInBuffer + this.newMsgStatistic - originalCellContent.msgStatistic;

            // Store the new msg count in the circular buffer (which will also trigger deletion of the oldest cell at the buffer trail), together with the msg data
            this.circularBuffer.enq({
                msgCount: this.newMsgCount,
                msgStatistic: this.newMsgStatistic 
            }); 
            
            var msgCountInBuffer = this.msgCountInBuffer;
            var msgStatisticInBuffer = this.msgStatisticInBuffer;
            var isStartup = false;
            
            // Do a linear interpolation if required (only relevant in the startup period)
            if (this.circularBuffer.size() < this.circularBuffer.capacity()) {
                 isStartup = true;

                 if (this.estimationStartup == true && this.circularBuffer.size() > 0) {
                    msgCountInBuffer = Math.floor(msgCountInBuffer * this.circularBuffer.capacity() / this.circularBuffer.size());
                    msgStatisticInBuffer = Math.floor(msgStatisticInBuffer * this.circularBuffer.capacity() / this.circularBuffer.size());
                }
            }
            
            // Update the status in the editor with the last message count (only if it has changed), or when switching between startup and real
            if (this.prevTotalMsgCount != this.msgCountInBuffer || this.prevMsgStatisticInBuffer != this.msgStatisticInBuffer || this.prevStartup != isStartup) {
                this.changeStatus(msgCountInBuffer, msgStatisticInBuffer, isStartup);
                
                this.prevTotalMsgCount = msgCountInBuffer;
                this.prevMsgStatisticInBuffer = msgStatisticInBuffer;
            }

            // Send a message on the first output port, when not ignored during the startup period
            if (this.ignoreStartup == false || isStartup == false) {
                this.sendMsg(msgCountInBuffer, msgStatisticInBuffer);
            }
            
            // When everything has been send (in the first second), start from 0 again
            this.newMsgCount = 0;
            this.newMsgStatistic = 0;
            
            // Our new second starts at the end of the previous second
            this.startTime = this.endTime;
            
            this.prevStartup = isStartup;
        }
        
        // When there is a message, it's statistics needs to be added to the NEXT second cell. 
        if (msg) {
            this.newMsgCount += 1;
            this.newMsgStatistic += this.calculateMsgStatistic(msg);
        }
    }
    
    calculateMsgStatistic(msg) {
        // The caller should override this method, to return the new msg statistic (numeric) value!!!!
    }
    
    sendMsg(msgCountInBuffer, msgStatisticInBuffer) {
        // The caller should override this method, to send an output message!!!!
    }
    
    changeStatus(msgCountInBuffer, msgStatisticInBuffer, isStartup) {
        // The caller should override this method, to change the node status!!!!
    }
};

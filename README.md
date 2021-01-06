# nr-msg-statistics
A library to offer a ring buffer for Node-RED msg statistics

The only purpose of this package is to share (msg statistic related) functionality between some of my Node-RED nodes, like e.g. [node-red-contrib-msg-speed](https://github.com/bartbutenaers/node-red-contrib-msg-speed) and [node-red-contrib-msg-size](https://github.com/bartbutenaers/node-red-contrib-msg-size).  So this is ***not*** indended as a general usable package!

This package creates a ring buffer containing of N cells, where each cell contains the statistics of all messages received during that second.

![Ring buffer](https://user-images.githubusercontent.com/14224149/103816612-89dfda00-5065-11eb-821e-42b9ef912573.png)

When the statistics (e.g. msg speed or size...) are required per minute, then the buffer needs to consist out of 60 cells.  During a second the statistic of a cell will be calculated for all the message that arrive during that second.  When the second has passed, the statistis will be calculated in the next cell.  And so on ...  Each second the pointer will be moved to the next cell of the ring buffer.

As soon as the time interval has exceeded (in this example 1 minute), the previous contents of the cells will be overwritten one by one.  At any moment in time, the sum of ALL values (in all cells) contain the total aggregated statistic of all messages that have arrived during the specified time interval.  When that total value is divided by the number of cells, we get the average statistic value for the specified time interval.

This allows us to calculate every second the total (and average) statistic value of the last N seconds.  However calculating every second the sum of all cells, would result in bad performance.  But that is avoided by this package using a simple trick:

However, calculating the sum of all cells every second would be very inefficient. So I use a simple trick to calculate the sum of the values in all cells:
1. The new_statistic_Value is calculated during the last second.
2. The old_statistic_Value is get from the current cell and overwritten by the new_statistic_Value.
3. The total_sum = total_sum - old_statistic_Value + new_statistic_Value

So the old counter (of the oldest second) is subtracted from the total sum, and the new counter (of the most recent second) is added to the sum.  That way the total sum is always up to date with the content of all cells...

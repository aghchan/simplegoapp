package logger

import "go.uber.org/zap"

type Logger interface {
	Info(msg string, keysAndValues ...interface{})
	Warn(msg string, keysAndValues ...interface{})
	Error(msg string, keysAndValues ...interface{})
	Fatal(msg string, keysAndValues ...interface{})
}

type logger struct {
	*zap.SugaredLogger
}

func NewService() Logger {
	l, _ := zap.NewProduction()
	defer l.Sync()

	return &logger{
		SugaredLogger: l.Sugar(),
	}
}

func (this logger) Info(msg string, keysAndValues ...interface{}) {
	this.Infow(msg, keysAndValues...)
}

func (this logger) Warn(msg string, keysAndValues ...interface{}) {
	this.Warnw(msg, keysAndValues...)
}

func (this logger) Error(msg string, keysAndValues ...interface{}) {
	this.Errorw(msg, keysAndValues...)
}

func (this logger) Fatal(msg string, keysAndValues ...interface{}) {
	this.Fatalw(msg, keysAndValues...)
}

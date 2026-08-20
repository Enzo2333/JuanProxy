//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

func notifyUser(message string, isError bool) {
	title, _ := syscall.UTF16PtrFromString(monitorName)
	text, _ := syscall.UTF16PtrFromString(message)
	flags := uintptr(0x40)
	if isError {
		flags = 0x10
	}
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	_, _, _ = messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), flags)
}

//go:build !windows

package main

import "fmt"

func notifyUser(message string, isError bool) {
	if isError {
		fmt.Println("ERROR:", message)
		return
	}
	fmt.Println(message)
}
